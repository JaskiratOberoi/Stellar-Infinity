using System.Data;
using Infinity.Api.Audit;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Worksheet;

/// <param name="Sid">The trimmed barcode — what the operator scans and searches.</param>
/// <param name="Sex">"M"/"F", or null when the patient (or their sex) is unknown.
/// The legacy grid rendered every unknown as "F"; null is the fix.</param>
public sealed record InwardRow(
    int Id,
    int? Slno,
    string? Sid,
    DateTimeOffset? ScannedAt,
    string? ScannedBy,
    string? Bunit,
    string? ReceivedOne, DateTimeOffset? ReceivedOneAt,
    string? ReceivedTwo, DateTimeOffset? ReceivedTwoAt,
    string? ReceivedThree, DateTimeOffset? ReceivedThreeAt,
    int? PatientId,
    string? PatientName,
    string? Sex,
    string? ClientCode,
    string? Tests,
    int? SampleStatus);

public sealed record InwardList(IReadOnlyList<InwardRow> Rows, int Total);

/// <param name="Outcome">new_leg | checkpoint_1 | checkpoint_2 | checkpoint_3 | already_full.</param>
/// <param name="NoWorkorder">The vial has no matching sample. The scan is still
/// LOGGED (contract KEEP #3 — the vial physically arrived); this flag is what
/// turns the feedback red.</param>
/// <param name="SampleStatus">The sample's status BEFORE any accession the
/// endpoint may trigger on the back of this scan.</param>
/// <param name="ScannerBusinessUnitId">The unit the scan was filed under —
/// resolved server-side from the actor's own account, never from the caller.
/// 1 is head office, which is what arms the accession trigger.</param>
public sealed record InwardScanOutcome(
    string Outcome,
    bool NoWorkorder,
    int? Slno,
    int? PatientId,
    string? PatientName,
    string? Sex,
    int? SampleStatus,
    string? Tests,
    string? OldBusinessUnit,
    int? ScannerBusinessUnitId,
    string? ScannerBusinessUnit);

/// <summary>
/// Sample transit tracking — the legacy Inward page's data, read and written
/// through Infinity's own procedures against the SAME legacy table
/// (tbl_acc_inward_sample_tracking), so the LIS page and this one see one
/// history.
///
/// The scan is the interesting half: usp_inf_inward_scan commits the tracking
/// leg, the sample's business-unit overwrite and its audit row in one
/// transaction, and REPORTS what happened. What it deliberately does not do is
/// accession — the endpoint reuses AccessionRepository.AccessionAsync for that,
/// because usp_telo_accession_samples already carries the whole billing chain
/// with its charge-once latch, and a second implementation would drift.
/// </summary>
public sealed class InwardRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>The list's default page of rows; the CSV export asks for more.</summary>
    public const int DefaultRows = 500;

    /// <summary>Hard ceiling, shared with the procedure (contract FIX #19).</summary>
    public const int MaxRows = 10_000;

    /// <param name="unrestricted">
    /// True when the caller sees every centre by role (admin, lab manager,
    /// reporting). It is NOT the same as an empty code list: lab staff also
    /// arrive with no codes, and for them the procedure's business-unit lock is
    /// the scope. The procedure fails closed on the third case — no codes, not
    /// unrestricted, no business unit. See D9 in docs/port-decisions.md.
    /// </param>
    public Task<InwardList> ListAsync(
        int actorUserId,
        IReadOnlyList<string> clientCodes,
        bool unrestricted,
        DateOnly from,
        DateOnly to,
        string? sid,
        int? mccId,
        string? bunit,
        int maxRows,
        CancellationToken ct = default) =>
        retry.ExecuteAsync("inward.list", token =>
            db.QueryAsync("inward.list", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_inward_list");
                cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = actorUserId;
                cmd.Parameters.Add("@unrestricted", SqlDbType.Bit).Value = unrestricted;
                AddCodesTvp(cmd, clientCodes);
                cmd.Parameters.Add("@from_date", SqlDbType.Date).Value = from.ToDateTime(TimeOnly.MinValue);
                cmd.Parameters.Add("@to_date", SqlDbType.Date).Value = to.ToDateTime(TimeOnly.MinValue);
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value =
                    string.IsNullOrWhiteSpace(sid) ? DBNull.Value : sid.Trim();
                cmd.Parameters.Add("@mcc_id", SqlDbType.Int).Value = (object?)mccId ?? DBNull.Value;
                cmd.Parameters.Add("@bunit", SqlDbType.VarChar, 50).Value =
                    string.IsNullOrWhiteSpace(bunit) ? DBNull.Value : bunit.Trim();
                cmd.Parameters.Add("@max_rows", SqlDbType.Int).Value =
                    Math.Clamp(maxRows, 1, MaxRows);

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<InwardRow>();
                var total = 0;
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (rows.Count == 0) total = r.NullableInt("total_count") ?? 0;

                    rows.Add(new InwardRow(
                        Id: r.Int("id"),
                        Slno: r.NullableInt("slno"),
                        Sid: r.Str("sid"),
                        ScannedAt: Domain.NobleTime.ToIst(r.Date("scanned_at")),
                        ScannedBy: r.Str("scanned_by")?.Trim(),
                        Bunit: r.Str("bunit"),
                        ReceivedOne: r.Str("received_one")?.Trim(),
                        ReceivedOneAt: Domain.NobleTime.ToIst(r.Date("received_one_at")),
                        ReceivedTwo: r.Str("received_two")?.Trim(),
                        ReceivedTwoAt: Domain.NobleTime.ToIst(r.Date("received_two_at")),
                        ReceivedThree: r.Str("received_three")?.Trim(),
                        ReceivedThreeAt: Domain.NobleTime.ToIst(r.Date("received_three_at")),
                        PatientId: r.NullableInt("patient_id"),
                        PatientName: r.Str("patient_name")?.Trim(),
                        Sex: MapSex(r.NullableInt("gender")),
                        ClientCode: r.Str("client_code"),
                        Tests: r.Str("tests"),
                        SampleStatus: r.NullableInt("sample_status")));
                }

                return new InwardList(rows, total);
            }, token), ct);

    /// <summary>
    /// One scan. NOT retried: a replay after an ambiguous timeout would fill a
    /// second checkpoint slot with the same user seconds apart — precisely the
    /// double-write the procedure's locking exists to prevent.
    /// </summary>
    public async Task<InwardScanOutcome> ScanAsync(
        string vailid, AuditActor actor, CancellationToken ct = default)
    {
        if (actor.UserId is not int userId)
        {
            throw new WorksheetRefusedException("The acting user could not be identified.", isPermission: true);
        }

        return await db.QueryAsync("inward.scan", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_inward_scan");
            cmd.Parameters.Add("@vailid", SqlDbType.NVarChar, 50).Value = vailid.Trim();
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@actor_ip", SqlDbType.VarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;

            try
            {
                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleRow, inner)
                    .ConfigureAwait(false);

                if (!await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    throw new WorksheetRefusedException("The scan produced no outcome.", isPermission: false);
                }

                return new InwardScanOutcome(
                    Outcome: r.Str("outcome") ?? "unknown",
                    NoWorkorder: r.Bool("no_workorder"),
                    Slno: r.NullableInt("slno"),
                    PatientId: r.NullableInt("patient_id"),
                    PatientName: r.Str("patient_name")?.Trim(),
                    Sex: MapSex(r.NullableInt("gender")),
                    SampleStatus: r.NullableInt("sample_status"),
                    Tests: r.Str("tests"),
                    OldBusinessUnit: r.Str("old_business_unit"),
                    ScannerBusinessUnitId: r.NullableInt("scanner_business_unit_id"),
                    ScannerBusinessUnit: r.Str("scanner_business_unit"));
            }
            catch (SqlException ex) when (ex.Class == 16)
            {
                throw new WorksheetRefusedException(
                    ex.Errors.Count > 0 ? ex.Errors[0].Message : ex.Message, isPermission: false);
            }
        }, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// 1 is male, any other non-null value female — the LIS convention. NULL
    /// stays null: the legacy CASE rendered every unknown as 'F' (FIX #12).
    /// </summary>
    private static string? MapSex(int? gender) =>
        gender is null ? null : gender == 1 ? "M" : "F";

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
