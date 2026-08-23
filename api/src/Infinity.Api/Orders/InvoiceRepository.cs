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

/// <summary>
/// Every editable field UNRESOLVED, exactly as stored. Null means "not set".
/// </summary>
/// <remarks>
/// The editor binds to these, never to the resolved values on
/// <see cref="InvoiceConfig"/>, and the distinction is the whole reason this
/// record exists.
///
/// For the flags: a client whose disclaimer is on only by DEFAULT would show
/// "Show", and saving that back writes an explicit true — silently opting them
/// out of ever following the default again. Nearly every client is on auto, so
/// one pass through the editor would pin the whole roster to today's defaults,
/// and the next change to those defaults would reach nobody.
///
/// For the text: identical failure, quieter. A resolved address is the config's
/// value OR the LIS's, and rendering that into a text box presents the LIS's own
/// address as though somebody typed it. The next Save copies it into the config
/// row, which then stops tracking the LIS — for every field the operator never
/// touched.
/// </remarks>
public sealed record InvoiceStored(
    string? LabName,
    string? Address,
    string? City,
    string? State,
    string? Pincode,
    string? Phone,
    string? Email,
    string? PreparedBy,
    string? OnBehalf,
    bool? ShowDisclaimer,
    bool? ShowSignatory);

/// <summary>
/// The client's own letterhead artwork, as stored. MDCARE prints under
/// Medicare's mark with Noble's hidden — which is what "the same way Telo
/// does it" means on a B2C bill.
/// </summary>
public sealed record InvoiceLogo(
    bool HasCustom, bool CustomVisible, bool NobleVisible, string Position);

/// <summary>The artwork itself, for the route that streams it.</summary>
public sealed record InvoiceLogoFile(byte[] Bytes, string Mime);

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
    InvoiceFlags Flags,
    InvoiceStored Stored)
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

    /// <summary>
    /// The ten fields the editor owns. Every one is sent on every save — see
    /// 83_usp_inf_invoice_config_save.sql for why there is no "leave this
    /// alone", and why the logo and layout columns are not in this list.
    /// </summary>
    /// <param name="OnBehalf">
    /// <c>client</c>, <c>qugen</c>, or null for the MDCARE-aware default.
    /// </param>
    public sealed record InvoiceConfigEdit(
        string? LabName,
        string? Address,
        string? City,
        string? State,
        string? Pincode,
        string? Phone,
        string? Email,
        string? PreparedBy,
        string? OnBehalf,
        bool? ShowDisclaimer,
        bool? ShowSignatory);

    /// <summary>
    /// Save the branding for one centre and return what a print would now use.
    /// </summary>
    /// <remarks>
    /// Deliberately NOT retried. The procedure is a single transaction and is
    /// idempotent in content — the same input twice leaves the same row — but
    /// it is also the write that changes a document Telo is printing right
    /// now, and a retry after an ambiguous timeout could apply an edit the
    /// operator has already navigated away from believing it failed. Reporting
    /// the failure and letting them look is the honest behaviour.
    ///
    /// The re-read is the point of returning a value: it comes back through
    /// the same procedure the invoice itself uses, so what the editor shows
    /// after saving is what the document will say, resolved defaults and all —
    /// rather than an echo of the form, which would agree even when the save
    /// had silently landed somewhere else.
    /// </remarks>
    public async Task<InvoiceConfig?> SaveAsync(int mcc, InvoiceConfigEdit edit, CancellationToken ct = default)
    {
        await db.QueryAsync("invoice.config.save", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_invoice_config_save");
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            Text(cmd, "@lab_name", 200, edit.LabName);
            Text(cmd, "@address", 500, edit.Address);
            Text(cmd, "@city", 120, edit.City);
            Text(cmd, "@state", 120, edit.State);
            Text(cmd, "@pincode", 20, edit.Pincode);
            Text(cmd, "@phone", 50, edit.Phone);
            Text(cmd, "@email", 200, edit.Email);
            Text(cmd, "@prepared_by", 120, edit.PreparedBy);

            cmd.Parameters.Add("@on_behalf_mode", SqlDbType.VarChar, 12).Value =
                string.IsNullOrWhiteSpace(edit.OnBehalf) ? DBNull.Value : edit.OnBehalf.Trim().ToLowerInvariant();
            cmd.Parameters.Add("@show_disclaimer", SqlDbType.Bit).Value =
                edit.ShowDisclaimer.HasValue ? edit.ShowDisclaimer.Value : DBNull.Value;
            cmd.Parameters.Add("@show_signatory", SqlDbType.Bit).Value =
                edit.ShowSignatory.HasValue ? edit.ShowSignatory.Value : DBNull.Value;

            await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
            return true;
        }, ct).ConfigureAwait(false);

        return await GetAsync(mcc, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The client's letterhead SETTINGS, read straight from the shared table
    /// rather than through usp_inf_invoice_config — the procedure predates
    /// these columns and Telo prints from the same row, so widening it would
    /// mean changing a procedure both systems depend on to add a field only
    /// one of them reads.
    /// </summary>
    public Task<InvoiceLogo> GetLogoAsync(int mcc, CancellationToken ct = default) =>
        retry.ExecuteAsync("invoice.logo.flags", token =>
            db.QueryAsync("invoice.logo.flags", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    SELECT has_custom = CASE WHEN top_right_logo_bytes IS NULL THEN 0 ELSE 1 END,
                           custom_visible = ISNULL(custom_logo_visible, 1),
                           noble_visible  = ISNULL(noble_logo_visible, 1),
                           position       = ISNULL(NULLIF(LTRIM(RTRIM(noble_logo_position)), ''), 'left')
                    FROM dbo.telo_mcc_invoice_config WHERE mcc_id = @mcc;
                    """);
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                // No row at all is the ordinary case: a client with no branding
                // prints under Noble's, which is the default below.
                if (!await r.ReadAsync(inner).ConfigureAwait(false))
                    return new InvoiceLogo(false, false, true, "left");
                return new InvoiceLogo(
                    r.Int("has_custom") == 1, r.Bool("custom_visible"),
                    r.Bool("noble_visible"), r.Str("position") ?? "left");
            }, token), ct);

    /// <summary>The artwork's bytes, or null when the client stores none.</summary>
    public Task<InvoiceLogoFile?> GetLogoFileAsync(int mcc, CancellationToken ct = default) =>
        retry.ExecuteAsync("invoice.logo.file", token =>
            db.QueryAsync("invoice.logo.file", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    SELECT top_right_logo_bytes AS bytes,
                           ISNULL(NULLIF(LTRIM(RTRIM(top_right_logo_mime)), ''), 'image/png') AS mime
                    FROM dbo.telo_mcc_invoice_config
                    WHERE mcc_id = @mcc AND top_right_logo_bytes IS NOT NULL;
                    """);
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (!await r.ReadAsync(inner).ConfigureAwait(false)) return null;
                return new InvoiceLogoFile((byte[])r["bytes"], r.Str("mime") ?? "image/png");
            }, token), ct);

    private static void Text(SqlCommand cmd, string name, int size, string? value) =>
        cmd.Parameters.Add(name, SqlDbType.NVarChar, size).Value =
            string.IsNullOrWhiteSpace(value) ? DBNull.Value : value.Trim();

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
                var mode = r.Str("onBehalfMode");
                var disclaimer = r.NullableBool("showDisclaimer");
                var signatory = r.NullableBool("showSignatory");

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
                    Flags: Resolve(mode, disclaimer, signatory, clientCode),
                    Stored: new InvoiceStored(
                        LabName: r.Str("cfgLabName"),
                        Address: r.Str("cfgAddress"),
                        City: r.Str("cfgCity"),
                        State: r.Str("cfgState"),
                        Pincode: r.Str("cfgPincode"),
                        Phone: r.Str("cfgPhone"),
                        Email: r.Str("cfgEmail"),
                        PreparedBy: r.Str("cfgPreparedBy"),
                        // Normalised the same way Resolve() does, so a stray
                        // value in the column cannot show the editor an option
                        // that is not in its list.
                        OnBehalf: string.IsNullOrWhiteSpace(mode) ? null
                            : mode.Trim().Equals("qugen", StringComparison.OrdinalIgnoreCase) ? "qugen" : "client",
                        ShowDisclaimer: disclaimer,
                        ShowSignatory: signatory));
            }, token), ct);
}
