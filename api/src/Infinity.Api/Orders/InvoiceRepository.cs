using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Orders;

/// <summary>
/// The three flags resolved: no nulls left, so the renderer never has to know
/// the defaulting rule.
/// </summary>
/// <param name="OnBehalf">
/// <c>client</c> — the invoice is issued in the client's own name.
/// <c>qugen</c> — issued by Qugen on the client's behalf.
/// </param>
public sealed record InvoiceFlags(string OnBehalf, bool ShowDisclaimer, bool ShowSignatory);

public sealed record InvoiceConfig(
    int MccId,
    string? ClientCode,
    string? ClientName,
    string? LabName,
    string? Address,
    string? City,
    string? State,
    string? Pincode,
    string? Phone,
    string? Email,
    string? PreparedBy,
    bool HasConfig,
    InvoiceFlags Flags)
{
    /// <summary>
    /// What the letterhead says. The config's <c>lab_name</c> overrides the
    /// LIS's unit name when set — some clients invoice under a trading name
    /// that differs from how they are recorded in the master.
    /// </summary>
    public string Heading =>
        !string.IsNullOrWhiteSpace(LabName) ? LabName!.Trim()
        : !string.IsNullOrWhiteSpace(ClientName) ? ClientName!.Trim()
        : ClientCode ?? "Noble Diagnostics";
}

public sealed class InvoiceRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>
    /// The disclaimer, verbatim from Telo. It is the sentence that keeps a bill
    /// from reading as a certificate of work done, so it is copied exactly
    /// rather than paraphrased — the two systems must print the same words
    /// while both are live.
    /// </summary>
    public const string DisclaimerText =
        "All tests to be performed in the lab of Noble Diagnostics. This is just an invoice of " +
        "the tests billed not proof that the tests have already been performed.";

    /// <summary>
    /// MEDICARE SUPER SPECIALITY HOSPITAL keeps the pre-config bill behaviour:
    /// issued on behalf of Qugen, signatory shown, no disclaimer. Everyone else
    /// gets the current defaults. Matched on MCCUnitCode because that is the
    /// stable identifier the config table and the LIS agree on.
    /// </summary>
    private static bool IsMdcare(string? clientCode) =>
        string.Equals(clientCode?.Trim(), "MDCARE", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Apply the tri-state defaults. Stored NULL means "not decided", NOT
    /// "off" — see 82_usp_inf_invoice_config.sql. Kept as one function so
    /// Infinity and Telo cannot drift into printing different documents for
    /// the same client while both systems are running.
    /// </summary>
    private static InvoiceFlags Resolve(string? mode, bool? disclaimer, bool? signatory, string? clientCode)
    {
        var md = IsMdcare(clientCode);
        var onBehalf = string.IsNullOrWhiteSpace(mode) ? (md ? "qugen" : "client") : mode!.Trim().ToLowerInvariant();
        // Anything unrecognised in the column falls back to the safe reading:
        // the client's own name. "qugen" is the exception that must be asked
        // for explicitly.
        if (onBehalf != "qugen") onBehalf = "client";
        return new InvoiceFlags(onBehalf, disclaimer ?? !md, signatory ?? md);
    }

    public Task<InvoiceConfig?> GetAsync(int mcc, CancellationToken ct = default) =>
        retry.ExecuteAsync("invoice.config", token =>
            db.QueryAsync("invoice.config", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_invoice_config");
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);
                if (!await r.ReadAsync(inner).ConfigureAwait(false)) return null;

                var clientCode = r.Str("clientCode");
                return new InvoiceConfig(
                    MccId: r.Int("mccId"),
                    ClientCode: clientCode,
                    ClientName: r.Str("clientName"),
                    LabName: r.Str("labName"),
                    Address: r.Str("address"),
                    City: r.Str("city"),
                    State: r.Str("state"),
                    Pincode: r.Str("pincode"),
                    Phone: r.Str("phone"),
                    Email: r.Str("email"),
                    PreparedBy: r.Str("preparedBy"),
                    HasConfig: r.Bool("hasConfig"),
                    Flags: Resolve(
                        r.Str("onBehalfMode"),
                        r.NullableBool("showDisclaimer"),
                        r.NullableBool("showSignatory"),
                        clientCode));
            }, token), ct);
}
