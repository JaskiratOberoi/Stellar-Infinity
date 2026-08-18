using System.Data;
using Infinity.Api.Data;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Worksheet;

/// <summary>
/// What the worksheet's "Edit patient info" form posts.
///
/// Every field is nullable and null means "leave alone", matching
/// usp_inf_update_patient_info. Clearing a text field is the empty string —
/// the same null-versus-empty convention the result grid uses, and load-bearing
/// for the same reason: this form posts every field on every save, so if both
/// meant the same thing an untouched field would wipe a value.
///
/// <para>
/// RefDoctor/RefCustomer are master-table ids; 0 means "no master row", which
/// pairs with a hand-typed name in the matching Other field. Listec's own
/// screen works this way — a dropdown plus a free-text box — because most
/// referrers are on file and a long tail never will be.
/// </para>
/// </summary>
public sealed record PatientInfoEdit(
    string? Title,
    string? Name,
    int? Age,
    int? AgeType,
    int? Gender,
    int? RefDoctor,
    string? RefDoctorOther,
    int? RefCustomer,
    string? RefCustomerOther,
    string? Mobile,
    string? Email,
    DateTime? SampleTime,
    string? ClinicalHistory);

/// <summary>Outcome of one edit. <paramref name="Changed"/> counts columns actually written.</summary>
public sealed record PatientEditResult(bool Ok, string? ErrorCode, int Changed);

/// <summary>
/// Writes patient demographics and referral from the worksheet.
///
/// Deliberately NOT routed through Telo's usp_telo_update_patient_info: that one
/// is keyed by bill and refuses any bill not stamped 'telo:%', which excludes
/// essentially every sample on the worksheet. See the header comment on
/// 104_usp_inf_update_patient_info.sql for the full reasoning.
/// </summary>
public sealed class PatientEditRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public Task<PatientEditResult> UpdateAsync(
        IReadOnlyList<string> clientCodes,
        string sid,
        int userId,
        string? username,
        PatientInfoEdit edit,
        CancellationToken ct = default)
    {
        // No retry wrapper around the write itself would be wrong in the other
        // direction — SqlRetry only replays on transient connection faults, and
        // the procedure is a single transaction that either commits or rolls
        // back, so a replayed call cannot double-apply.
        return retry.ExecuteAsync("worksheet.patientEdit", token =>
            db.QueryAsync("worksheet.patientEdit", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_update_patient_info");
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid.Trim();
                cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
                Add(cmd, "@username", SqlDbType.NVarChar, 100, username);
                Add(cmd, "@title", SqlDbType.VarChar, 10, edit.Title);
                Add(cmd, "@name", SqlDbType.NVarChar, 400, edit.Name);
                AddInt(cmd, "@age", edit.Age);
                AddInt(cmd, "@age_type", edit.AgeType);
                AddInt(cmd, "@gender", edit.Gender);
                AddInt(cmd, "@ref_doctor", edit.RefDoctor);
                Add(cmd, "@ref_doctor_other", SqlDbType.VarChar, 200, edit.RefDoctorOther);
                AddInt(cmd, "@ref_customer", edit.RefCustomer);
                Add(cmd, "@ref_customer_other", SqlDbType.VarChar, 200, edit.RefCustomerOther);
                Add(cmd, "@mobile", SqlDbType.VarChar, 20, edit.Mobile);
                Add(cmd, "@email", SqlDbType.VarChar, 100, edit.Email);
                cmd.Parameters.Add("@sample_time", SqlDbType.DateTime).Value =
                    (object?)edit.SampleTime ?? DBNull.Value;
                cmd.Parameters.Add("@clinical_history", SqlDbType.NVarChar, -1).Value =
                    (object?)edit.ClinicalHistory ?? DBNull.Value;
                WorksheetRepository.AddClientCodes(cmd, clientCodes);

                await using var reader = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (!await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    return new PatientEditResult(false, "NO_RESULT", 0);
                }

                return new PatientEditResult(
                    Ok: reader.GetBoolean(reader.GetOrdinal("ok")),
                    ErrorCode: reader.IsDBNull(reader.GetOrdinal("error_code"))
                        ? null
                        : reader.GetString(reader.GetOrdinal("error_code")),
                    Changed: reader.GetInt32(reader.GetOrdinal("changed")));
            }, token), ct);
    }

    private static void Add(SqlCommand cmd, string name, SqlDbType type, int size, string? value) =>
        cmd.Parameters.Add(name, type, size).Value = (object?)value ?? DBNull.Value;

    private static void AddInt(SqlCommand cmd, string name, int? value) =>
        cmd.Parameters.Add(name, SqlDbType.Int).Value = (object?)value ?? DBNull.Value;
}
