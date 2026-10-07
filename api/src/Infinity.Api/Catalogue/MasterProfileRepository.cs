using System.Data;
using System.Text.Json;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Catalogue;

/// <summary>One row of the Master Profiles list.</summary>
public sealed record MasterProfileRow(
    int Id, string Code, string Name, int? Ct, int? Mrp, bool IsActive,
    int ProfileCount, int TestCount, string? Members,
    string? CreatedBy, DateTime? CreatedDate, string? ModifiedBy, DateTime? ModifiedDate);

/// <summary>A member of a package: a profile or a test.</summary>
/// <param name="SnapshotName">The name stored on the package at save time — what the order and the report print.</param>
/// <param name="CurrentName">What the catalogue calls it now; differs when the member was renamed since.</param>
public sealed record MasterProfileMember(
    string Kind, int Id, string? Code, string? SnapshotName, string? CurrentName,
    int? Mrp, bool IsActive, bool ExistsNow);

public sealed record MasterProfileDetail(
    int Id, string Code, string Name, int? Ct, int? Mrp, bool IsActive,
    string? CreatedBy, DateTime? CreatedDate, string? ModifiedBy, DateTime? ModifiedDate,
    int OrderedCount, bool SmartReport,
    IReadOnlyList<MasterProfileMember> Members);

/// <summary>A choice in the member picker.</summary>
public sealed record PickerItem(int Id, string? Code, string? Name, int? Mrp, int? DepartmentId);

public sealed record MemberRef(string Kind, int Id);

public sealed record SaveResult(bool Ok, string? ErrorCode, string? Message, int? Id);

/// <summary>
/// Master Profiles (packages) — the port of the legacy Technical > Master
/// Profile page. Every write goes through the procedures of script 179,
/// which write the SHARED catalogue tables the way the LIS does, so a
/// package made here is one the LIS, Telo and the order procedures all see.
/// </summary>
public sealed class MasterProfileRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public Task<(IReadOnlyList<MasterProfileRow> Rows, int Total)> ListAsync(
        string? search, int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("masterprofile.list", token =>
            db.QueryAsync("masterprofile.list", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_master_profile_list");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value = (object?)search ?? DBNull.Value;
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = page;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = pageSize;
                var rows = new List<MasterProfileRow>();
                var total = 0;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    total = r.Int("total");
                    rows.Add(new MasterProfileRow(
                        r.Int("id"), r.Str("code") ?? string.Empty, r.Str("name") ?? string.Empty,
                        r.NullableInt("ct"), r.NullableInt("mrp"), r.Bool("is_active"),
                        r.Int("profile_count"), r.Int("test_count"), r.Str("members"),
                        r.Str("created_by"), r.Date("created_date"), r.Str("modified_by"), r.Date("modified_date")));
                }
                return ((IReadOnlyList<MasterProfileRow>)rows, total);
            }, token), ct);

    public Task<MasterProfileDetail?> GetAsync(int id, CancellationToken ct = default) =>
        retry.ExecuteAsync("masterprofile.get", token =>
            db.QueryAsync("masterprofile.get", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_master_profile_get");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (!await r.ReadAsync(inner).ConfigureAwait(false)) return null;
                var head = (
                    Id: r.Int("id"), Code: r.Str("code") ?? string.Empty, Name: r.Str("name") ?? string.Empty,
                    Ct: r.NullableInt("ct"), Mrp: r.NullableInt("mrp"), IsActive: r.Bool("is_active"),
                    CreatedBy: r.Str("created_by"), CreatedDate: r.Date("created_date"),
                    ModifiedBy: r.Str("modified_by"), ModifiedDate: r.Date("modified_date"),
                    Ordered: r.Int("ordered_count"), Smart: r.Int("smart_report") == 1);
                var members = new List<MasterProfileMember>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        members.Add(new MasterProfileMember(
                            r.Str("kind") ?? "test", r.Int("id"), r.Str("code"), r.Str("snapshot_name"), r.Str("current_name"),
                            r.NullableInt("mrp"), r.Bool("is_active"), r.Int("exists_now") == 1));
                }
                return new MasterProfileDetail(
                    head.Id, head.Code, head.Name, head.Ct, head.Mrp, head.IsActive,
                    head.CreatedBy, head.CreatedDate, head.ModifiedBy, head.ModifiedDate,
                    head.Ordered, head.Smart, members);
            }, token), ct);

    public Task<SaveResult> SaveAsync(
        int? id, string code, string name, int? ctPrice, int? mrp, bool isActive,
        IReadOnlyList<MemberRef> members, string by, CancellationToken ct = default) =>
        retry.ExecuteAsync("masterprofile.save", token =>
            db.QueryAsync("masterprofile.save", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_master_profile_save");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = (object?)id ?? DBNull.Value;
                cmd.Parameters.Add("@code", SqlDbType.NVarChar, 100).Value = code;
                cmd.Parameters.Add("@name", SqlDbType.NVarChar, 400).Value = name;
                cmd.Parameters.Add("@ct", SqlDbType.Int).Value = (object?)ctPrice ?? DBNull.Value;
                cmd.Parameters.Add("@mrp", SqlDbType.Int).Value = (object?)mrp ?? DBNull.Value;
                cmd.Parameters.Add("@is_active", SqlDbType.Bit).Value = isActive;
                cmd.Parameters.Add("@members", SqlDbType.NVarChar, -1).Value =
                    JsonSerializer.Serialize(members.Select(m => new { kind = m.Kind, id = m.Id }));
                cmd.Parameters.Add("@by", SqlDbType.NVarChar, 100).Value = by;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (!await r.ReadAsync(inner).ConfigureAwait(false))
                    return new SaveResult(false, "UNKNOWN", "The save returned nothing.", null);
                return new SaveResult(r.Bool("ok"), r.Str("error_code"), r.Str("message"), r.NullableInt("id"));
            }, token), ct);

    public Task<bool> SetActiveAsync(int id, bool active, string by, CancellationToken ct = default) =>
        retry.ExecuteAsync("masterprofile.active", token =>
            db.QueryAsync("masterprofile.active", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_master_profile_set_active");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
                cmd.Parameters.Add("@active", SqlDbType.Bit).Value = active;
                cmd.Parameters.Add("@by", SqlDbType.NVarChar, 100).Value = by;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                return await r.ReadAsync(inner).ConfigureAwait(false) && r.Bool("ok");
            }, token), ct);

    public Task<SaveResult> DeleteAsync(int id, CancellationToken ct = default) =>
        retry.ExecuteAsync("masterprofile.delete", token =>
            db.QueryAsync("masterprofile.delete", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_master_profile_delete");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (!await r.ReadAsync(inner).ConfigureAwait(false))
                    return new SaveResult(false, "UNKNOWN", "The delete returned nothing.", null);
                return new SaveResult(r.Bool("ok"), r.Str("error_code"), r.Str("message"), null);
            }, token), ct);

    public Task<IReadOnlyList<PickerItem>> PickerAsync(string kind, string? search, CancellationToken ct = default) =>
        retry.ExecuteAsync("masterprofile.picker", token =>
            db.QueryAsync("masterprofile.picker", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_master_profile_picker");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@kind", SqlDbType.NVarChar, 10).Value = kind;
                cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value = (object?)search ?? DBNull.Value;
                var list = new List<PickerItem>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    list.Add(new PickerItem(r.Int("id"), r.Str("code"), r.Str("name"), r.NullableInt("mrp"), r.NullableInt("department_id")));
                return (IReadOnlyList<PickerItem>)list;
            }, token), ct);
}
