using System.Data;
using Infinity.Api.Auth;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Orders;

/// <param name="Origin">infinity | telo — which platform booked the order.</param>
/// <param name="RequiredGroups">Distinct tube types this order needs.</param>
/// <param name="HaveGroups">Barcodes attached so far. Short of Required means it is in this queue.</param>
public sealed record PendingAccession(
    int BillId,
    int? BillNumber,
    DateTimeOffset? BillDate,
    int PatientId,
    string? PatientName,
    int? MccCode,
    string? ClientCode,
    decimal Total,
    decimal Balance,
    string Origin,
    int RequiredGroups,
    int HaveGroups);

/// <summary>
/// A sample that HAS a barcode but has not been received by the LIS. Status 1
/// (Sample Sent), which the worksheet excludes — so it is not on any bench list
/// until it is registered.
/// </summary>
public sealed record PendingRegistration(
    long SampleId,
    string? Vailid,
    int PatientId,
    string? PatientName,
    int? MccCode,
    string? ClientCode,
    int SampleStatus,
    string? SampleTypeName,
    string? TestNames,
    DateTimeOffset? AddedAt,
    string Origin);

public sealed record AddSidsResult(
    bool Ok, string? ErrorCode, string? Message, IReadOnlyList<IssuedSample> Samples);

/// <param name="Skipped">
/// Samples in the batch that were already accessioned or not found. Surfaced
/// rather than swallowed: scanning a rack and being told "12 registered" when
/// three were skipped hides the three, and those are the ones that will not
/// appear on the worksheet.
/// </param>
public sealed record AccessionResult(
    bool Ok, string? ErrorCode, string? Message, int Registered, int Skipped);

/// <summary>
/// Accessioning: the two steps between a booked order and a sample on the
/// bench.
///
/// Both worklists come from Infinity's own procedures (79_usp_inf_accessioning)
/// which match telo: AND inf: orders — the lab is one lab, and a queue that
/// showed only one platform's work would leave the other's samples stuck with
/// nothing reporting them.
///
/// Both WRITES go through Telo's procedures, for the same reason order creation
/// does: they already encode the LIS's rules about barcode uniqueness, sample
/// splitting and result-skeleton generation, and a second implementation would
/// drift. usp_telo_add_sids was parameterised for this (Telo 68007fd);
/// usp_telo_accession_samples needed nothing, because it stamps modifiedby with
/// the LIS username rather than an origin marker.
/// </summary>
public sealed class AccessionRepository(NobleConnectionFactory db, SqlRetry retry)
{
    private const string Origin = "inf:";

    public Task<Paged<PendingAccession>> PendingAccessionsAsync(
        IReadOnlyList<string> clientCodes, int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("accession.pending", token =>
            db.QueryAsync("accession.pending", async (conn, inner) =>
            {
                var (p, size) = Paged<PendingAccession>.Clamp(page, pageSize, 100);

                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_pending_accessions");
                AddCodesTvp(cmd, clientCodes);
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = p;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<PendingAccession>();
                var total = 0;
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (rows.Count == 0) total = r.NullableInt("total_count") ?? 0;

                    rows.Add(new PendingAccession(
                        BillId: r.Int("billId"),
                        BillNumber: r.NullableInt("billNumber"),
                        BillDate: Domain.NobleTime.ToIst(r.Date("billDate")),
                        PatientId: r.Int("patientId"),
                        PatientName: r.Str("patientName")?.Trim(),
                        MccCode: r.NullableInt("mccCode"),
                        ClientCode: r.Str("clientCode"),
                        Total: r.Dec("total"),
                        Balance: r.Dec("balance"),
                        Origin: r.Str("origin") ?? "telo",
                        RequiredGroups: r.NullableInt("requiredGroups") ?? 0,
                        HaveGroups: r.NullableInt("haveGroups") ?? 0));
                }

                return new Paged<PendingAccession>(rows, total, p, size);
            }, token), ct);

    public Task<Paged<PendingRegistration>> PendingRegistrationsAsync(
        IReadOnlyList<string> clientCodes, int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("accession.pendingReg", token =>
            db.QueryAsync("accession.pendingReg", async (conn, inner) =>
            {
                var (p, size) = Paged<PendingRegistration>.Clamp(page, pageSize, 100);

                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_pending_registrations");
                AddCodesTvp(cmd, clientCodes);
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = p;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<PendingRegistration>();
                var total = 0;
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (rows.Count == 0) total = r.NullableInt("total_count") ?? 0;

                    rows.Add(new PendingRegistration(
                        SampleId: Convert.ToInt64(r.GetValue(r.GetOrdinal("sampleId"))),
                        Vailid: r.Str("vailid"),
                        PatientId: r.Int("patientId"),
                        PatientName: r.Str("patientName")?.Trim(),
                        MccCode: r.NullableInt("mccCode"),
                        ClientCode: r.Str("clientCode"),
                        SampleStatus: r.NullableInt("sampleStatus") ?? 0,
                        SampleTypeName: r.Str("sampleTypeName"),
                        TestNames: r.Str("testNames"),
                        AddedAt: Domain.NobleTime.ToIst(r.Date("addedAt")),
                        Origin: r.Str("origin") ?? "telo"));
                }

                return new Paged<PendingRegistration>(rows, total, p, size);
            }, token), ct);

    /// <summary>
    /// Attach barcodes to an order's tubes.
    ///
    /// NOT retried. Barcodes are globally unique in Noble, so a replay after a
    /// timeout would fail on its own first attempt's rows — and the caller
    /// would read that as "the barcode is already used" when it was used by
    /// them, a second earlier.
    /// </summary>
    public Task<AddSidsResult> AddSidsAsync(
        int userId, int patientId, int mcc, IReadOnlyList<SampleSid> sids,
        CancellationToken ct = default) =>
        db.QueryAsync("accession.addSids", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_add_sids");
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@patientId", SqlDbType.Int).Value = patientId;
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;

            var t = new DataTable();
            t.Columns.Add("sampleTypeId", typeof(int));
            t.Columns.Add("vailid", typeof(string));
            var seen = new HashSet<int>();
            foreach (var s in sids)
            {
                if (string.IsNullOrWhiteSpace(s.Vailid)) continue;
                if (!seen.Add(s.SampleTypeId)) continue;
                t.Rows.Add(s.SampleTypeId, s.Vailid.Trim());
            }
            var p = cmd.Parameters.AddWithValue("@sids", t);
            p.SqlDbType = SqlDbType.Structured;
            p.TypeName = "dbo.TeloSampleSid";

            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 20).Value = Origin;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            var ok = false;
            string? code = null, message = null;
            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                ok = r.GetOrdinalBool("ok");
                code = r.Str("error_code");
                message = r.Str("message");
            }

            var samples = new List<IssuedSample>();
            if (await r.NextResultAsync(inner).ConfigureAwait(false))
            {
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    samples.Add(new IssuedSample(
                        r.NullableInt("sample_id") ?? 0,
                        r.Str("vailid"),
                        r.NullableInt("sample_type_id") ?? -1,
                        r.Str("sample_type_name")));
                }
            }

            return new AddSidsResult(ok, code, message, samples);
        }, ct);

    /// <summary>
    /// Receive the samples into the LIS: status 1 -> 2, result skeletons
    /// generated, and from that moment they are on the worksheet.
    ///
    /// NOT retried — it writes result rows, and a replay would duplicate them.
    /// </summary>
    /// <param name="username">
    /// The LIS username, stamped into modifiedby. This procedure records WHO
    /// received the sample rather than which platform did, which is why it
    /// needed no origin parameter.
    /// </param>
    public Task<AccessionResult> AccessionAsync(
        int userId, string username, IReadOnlyList<string> vailids,
        CancellationToken ct = default) =>
        db.QueryAsync("accession.register", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_accession_samples");
            // Generates a result skeleton per test on every sample; a bulk
            // accession of a full rack is not a short query.
            cmd.CommandTimeout = 120;

            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@user", SqlDbType.NVarChar, 50).Value = username;

            var t = new DataTable();
            t.Columns.Add("vailid", typeof(string));
            foreach (var v in vailids.Where(v => !string.IsNullOrWhiteSpace(v))
                                     .Select(v => v.Trim())
                                     .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                t.Rows.Add(v);
            }
            var p = cmd.Parameters.AddWithValue("@vailids", t);
            p.SqlDbType = SqlDbType.Structured;
            p.TypeName = "dbo.TeloVailidList";

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            var ok = false;
            string? code = null, message = null;
            var registered = 0;
            var skipped = 0;
            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                ok = r.GetOrdinalBool("ok");
                code = r.Str("error_code");
                message = r.Str("message");
                registered = r.NullableInt("registered") ?? 0;
                skipped = r.NullableInt("skipped") ?? 0;
            }

            return new AccessionResult(ok, code, message, registered, skipped);
        }, ct);

    private static void AddCodesTvp(SqlCommand cmd, IReadOnlyList<string> clientCodes)
    {
        var tvp = new DataTable();
        tvp.Columns.Add("code", typeof(string));
        foreach (var c in clientCodes.Where(c => !string.IsNullOrWhiteSpace(c))
                                     .Select(c => c.Trim().ToUpperInvariant())
                                     .Distinct(StringComparer.Ordinal))
        {
            tvp.Rows.Add(c);
        }

        var p = cmd.Parameters.AddWithValue("@client_codes", tvp);
        p.SqlDbType = SqlDbType.Structured;
        p.TypeName = "dbo.ClientCodeList";
    }
}
