using System.Data;
using Infinity.Api.Auth;
using Infinity.Api.Data;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Admin;

public sealed record AdminUserRow(
    int UserId,
    string Username,
    string? FirstName,
    string? LastName,
    string? Email,
    int? UsertypeId,
    string? UsertypeName,
    bool LisIsActive,
    /// <summary>infinity | telo | lis — which system may manage this account.</summary>
    string ManagedBy,
    bool? InfinityActive,
    bool? InfinityLisAccess,
    string? InfinityRole,
    string EffectiveRole,
    int SessionVersion);

public sealed record AdminUserPage(IReadOnlyList<AdminUserRow> Users, int TotalCount);

public sealed record CreateUserRequest(
    string Username,
    string Password,
    string FirstName,
    string? LastName,
    string? Email,
    int LisUsertypeId,
    string InfinityRole,
    bool GrantLisAccess = false);

/// <summary>
/// Thin wrappers over the usp_inf_admin_* procedures. All authorization,
/// validation and the shared-column guards live in SQL — these do not re-decide
/// anything, they just marshal parameters and read the result row.
///
/// Writes are NOT retried: the procedures are transactional but not idempotent,
/// and replaying a create would mint a second user.
/// </summary>
public sealed class AdminRepository(NobleConnectionFactory db)
{
    public Task<AdminUserPage> ListUsersAsync(string? search, int page, int pageSize, CancellationToken ct = default) =>
        db.QueryAsync("admin.listUsers", async (conn, inner) =>
        {
            await using var cmd = new SqlCommand("dbo.usp_inf_admin_list_users", conn)
            {
                CommandType = CommandType.StoredProcedure,
            };
            cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value = (object?)search ?? DBNull.Value;
            cmd.Parameters.Add("@page", SqlDbType.Int).Value = page;
            cmd.Parameters.Add("@pageSize", SqlDbType.Int).Value = pageSize;

            await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                .ConfigureAwait(false);

            var rows = new List<AdminUserRow>();
            var total = 0;

            while (await reader.ReadAsync(inner).ConfigureAwait(false))
            {
                var explicitRole = reader.GetOrdinalString("infinity_role");
                var usertypeId = reader.GetOrdinalInt32("usertype_id");

                rows.Add(new AdminUserRow(
                    UserId: reader.GetOrdinalInt32("user_id") ?? 0,
                    Username: reader.GetOrdinalString("username") ?? "",
                    FirstName: reader.GetOrdinalString("first_name"),
                    LastName: reader.GetOrdinalString("last_name"),
                    Email: reader.GetOrdinalString("email"),
                    UsertypeId: usertypeId,
                    UsertypeName: reader.GetOrdinalString("usertype_name"),
                    LisIsActive: reader.GetOrdinalBool("lis_is_active"),
                    ManagedBy: reader.GetOrdinalString("managed_by") ?? "lis",
                    InfinityActive: reader.GetOrdinalNullableBool("infinity_active"),
                    InfinityLisAccess: reader.GetOrdinalNullableBool("infinity_lis_access"),
                    InfinityRole: explicitRole,
                    // Show what the user will actually get, not just what is
                    // stored — most users have no explicit row and the derived
                    // role is the one that matters.
                    EffectiveRole: InfinityRoles.Resolve(explicitRole, usertypeId),
                    SessionVersion: reader.GetOrdinalInt32("session_version") ?? 0));

                total = reader.GetOrdinalInt32("total_count") ?? total;
            }

            return new AdminUserPage(rows, total);
        }, ct);

    public Task<SpResult> CreateUserAsync(CreateUserRequest req, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.createUser", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_create_user");
            cmd.Parameters.Add("@username", SqlDbType.NVarChar, 50).Value = req.Username;
            cmd.Parameters.Add("@password", SqlDbType.NVarChar, 50).Value = req.Password;
            cmd.Parameters.Add("@firstName", SqlDbType.NVarChar, 100).Value = req.FirstName;
            cmd.Parameters.Add("@lastName", SqlDbType.NVarChar, 100).Value = (object?)req.LastName ?? DBNull.Value;
            cmd.Parameters.Add("@email", SqlDbType.NVarChar, 100).Value = (object?)req.Email ?? DBNull.Value;
            cmd.Parameters.Add("@lisUsertypeId", SqlDbType.Int).Value = req.LisUsertypeId;
            cmd.Parameters.Add("@infinityRole", SqlDbType.NVarChar, 30).Value = req.InfinityRole;
            cmd.Parameters.Add("@grantLisAccess", SqlDbType.Bit).Value = req.GrantLisAccess;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            return await ReadSpResultAsync(cmd, inner, withUserId: true).ConfigureAwait(false);
        }, ct);

    public Task<SpResult> SetLisAccessAsync(int userId, bool enabled, int actor, CancellationToken ct = default) =>
        ExecToggleAsync("dbo.usp_inf_admin_set_lis_access", "@enabled", userId, enabled, actor, ct);

    public Task<SpResult> SetActiveAsync(int userId, bool active, int actor, CancellationToken ct = default) =>
        ExecToggleAsync("dbo.usp_inf_admin_set_active", "@active", userId, active, actor, ct);

    public Task<SpResult> SetRoleAsync(int userId, string role, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.setRole", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_set_role");
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@role", SqlDbType.NVarChar, 30).Value = role;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            return await ReadSpResultAsync(cmd, inner).ConfigureAwait(false);
        }, ct);

    /// <summary>
    /// Full settings for one user, including the client codes they can reach.
    /// Three result sets in one round trip — see procedure 61.
    /// </summary>
    public Task<AdminUserDetail?> GetUserDetailAsync(int userId, CancellationToken ct = default) =>
        db.QueryAsync("admin.userDetail", async (conn, inner) =>
        {
            await using var cmd = new SqlCommand("dbo.usp_inf_admin_user_detail", conn)
            {
                CommandType = CommandType.StoredProcedure,
            };
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            if (!await r.ReadAsync(inner).ConfigureAwait(false)) return null;

            var explicitRole = r.GetOrdinalString("infinity_role");
            var usertypeId = r.GetOrdinalInt32("usertype_id");
            var effectiveRole = InfinityRoles.Resolve(explicitRole, usertypeId);

            var head = new
            {
                UserId = r.GetOrdinalInt32("user_id") ?? 0,
                Username = r.GetOrdinalString("username") ?? "",
                FirstName = r.GetOrdinalString("first_name"),
                LastName = r.GetOrdinalString("last_name"),
                Email = r.GetOrdinalString("email"),
                UsertypeId = usertypeId,
                UsertypeName = r.GetOrdinalString("usertype_name"),
                PccId = r.GetOrdinalInt32("pcc_id"),
                SubPccId = r.GetOrdinalInt32("sub_pcc_id"),
                BusinessUnitId = r.GetOrdinalInt32("business_unit_id"),
                LisIsActive = r.GetOrdinalBool("lis_is_active"),
                ManagedBy = r.GetOrdinalString("managed_by") ?? "lis",
                InfinityActive = r.GetOrdinalNullableBool("infinity_active"),
                InfinityLisAccess = r.GetOrdinalNullableBool("infinity_lis_access"),
                SessionVersion = r.GetOrdinalInt32("session_version") ?? 0,
                Lis = new LisSecurityBits(
                    r.GetOrdinalBool("lis_cap_auth"),
                    r.GetOrdinalBool("lis_cap_result_entry"),
                    r.GetOrdinalBool("lis_cap_edit_tests"),
                    r.GetOrdinalBool("lis_cap_discount")),
            };

            var codes = new List<MappedClientCode>();
            await r.NextResultAsync(inner).ConfigureAwait(false);
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                codes.Add(new MappedClientCode(
                    r.GetOrdinalInt32("mcc_id") ?? 0,
                    r.GetOrdinalString("client_code"),
                    r.GetOrdinalString("client_name"),
                    r.GetOrdinalString("added_by"),
                    r.GetOrdinalDateTimeOffset("added_at"),
                    r.GetOrdinalBool("added_by_infinity")));
            }

            var own = new List<OwnCentre>();
            await r.NextResultAsync(inner).ConfigureAwait(false);
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                own.Add(new OwnCentre(
                    r.GetOrdinalInt32("mcc_id") ?? 0,
                    r.GetOrdinalString("client_code"),
                    r.GetOrdinalString("client_name"),
                    r.GetOrdinalString("source") ?? ""));
            }

            return new AdminUserDetail(
                head.UserId, head.Username, head.FirstName, head.LastName, head.Email,
                head.UsertypeId, head.UsertypeName, head.PccId, head.SubPccId, head.BusinessUnitId,
                head.LisIsActive, head.ManagedBy, head.InfinityActive, head.InfinityLisAccess,
                explicitRole, effectiveRole,
                InfinityRoles.CapabilitiesFor(effectiveRole).OrderBy(c => c, StringComparer.Ordinal).ToArray(),
                head.SessionVersion, head.Lis, codes, own);
        }, ct);

    public Task<Paged<ClientCodeOption>> SearchClientCodesAsync(
        int userId, string? search, int page, int pageSize, CancellationToken ct = default) =>
        db.QueryAsync("admin.clientSearch", async (conn, inner) =>
        {
            var (p, size) = Paged<ClientCodeOption>.Clamp(page, pageSize, 50, maxSize: 500);

            await using var cmd = new SqlCommand("dbo.usp_inf_admin_client_search", conn)
            {
                CommandType = CommandType.StoredProcedure,
            };
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value = (object?)search ?? DBNull.Value;
            cmd.Parameters.Add("@page", SqlDbType.Int).Value = p;
            cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            var list = new List<ClientCodeOption>();
            var total = 0;
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                if (list.Count == 0) total = r.GetOrdinalInt32("total_count") ?? 0;

                list.Add(new ClientCodeOption(
                    r.GetOrdinalInt32("mcc_id") ?? 0,
                    r.GetOrdinalString("client_code") ?? "",
                    r.GetOrdinalString("client_name"),
                    r.GetOrdinalBool("already_mapped")));
            }
            return new Paged<ClientCodeOption>(list, total, p, size);
        }, ct);

    /// <summary>
    /// Replace a user's client-code access with exactly <paramref name="codes"/>.
    /// Returns the per-row changes so the caller can audit what was actually
    /// granted and revoked, rather than just that something changed.
    /// </summary>
    public Task<SetClientCodesResult> SetClientCodesAsync(
        int userId, IReadOnlyCollection<string> codes, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.setClientCodes", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_set_client_codes");
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            var tvp = new DataTable();
            tvp.Columns.Add("code", typeof(string));
            foreach (var c in codes.Where(c => !string.IsNullOrWhiteSpace(c))
                                   .Select(c => c.Trim())
                                   .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                tvp.Rows.Add(c);
            }
            var p = cmd.Parameters.AddWithValue("@codes", tvp);
            p.SqlDbType = SqlDbType.Structured;
            p.TypeName = "dbo.ClientCodeList";

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new SetClientCodesResult(false, "INTERNAL", "The operation returned no result.", 0, 0);

            var result = new SetClientCodesResult(
                r.GetOrdinalBool("ok"),
                r.GetOrdinalString("error_code"),
                r.GetOrdinalString("message"),
                r.GetOrdinalInt32("added") ?? 0,
                r.GetOrdinalInt32("removed") ?? 0);

            if (!result.Ok) return result;

            var changes = new List<ClientCodeChange>();
            if (await r.NextResultAsync(inner).ConfigureAwait(false))
            {
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    changes.Add(new ClientCodeChange(
                        r.GetOrdinalString("change") ?? "",
                        r.GetOrdinalInt32("mcc_id") ?? 0,
                        r.GetOrdinalString("client_code"),
                        r.GetOrdinalString("prior_owner")));
                }
            }

            return result with { Changes = changes };
        }, ct);

    public Task<SpResult> UpdateProfileAsync(
        int userId, UpdateProfileRequest req, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.updateProfile", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_update_profile");
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@firstName", SqlDbType.NVarChar, 100).Value = req.FirstName;
            cmd.Parameters.Add("@lastName", SqlDbType.NVarChar, 100).Value = (object?)req.LastName ?? DBNull.Value;
            cmd.Parameters.Add("@email", SqlDbType.NVarChar, 100).Value = (object?)req.Email ?? DBNull.Value;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            return await ReadSpResultAsync(cmd, inner).ConfigureAwait(false);
        }, ct);

    public Task<SpResult> ResetPasswordAsync(int userId, string password, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.resetPassword", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_reset_password");
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@password", SqlDbType.NVarChar, 50).Value = password;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            return await ReadSpResultAsync(cmd, inner).ConfigureAwait(false);
        }, ct);

    private Task<SpResult> ExecToggleAsync(
        string proc, string flagParam, int userId, bool value, int actor, CancellationToken ct) =>
        db.QueryAsync($"admin.{proc}", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, proc);
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add(flagParam, SqlDbType.Bit).Value = value;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            return await ReadSpResultAsync(cmd, inner).ConfigureAwait(false);
        }, ct);

    private static async Task<SpResult> ReadSpResultAsync(SqlCommand cmd, CancellationToken ct, bool withUserId = false)
    {
        await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, ct).ConfigureAwait(false);

        if (!await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            // A procedure that returns no row has hit a path we did not model;
            // treat it as failure rather than assuming success.
            return new SpResult(false, "INTERNAL", "The operation returned no result.");
        }

        return new SpResult(
            Ok: reader.GetOrdinalBool("ok"),
            ErrorCode: reader.GetOrdinalString("error_code"),
            Message: reader.GetOrdinalString("message"),
            UserId: withUserId ? reader.GetOrdinalInt32("user_id") : null);
    }
}

internal static class AdminReaderExtensions
{
    public static DateTimeOffset? GetOrdinalDateTimeOffset(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        if (r.IsDBNull(i)) return null;
        var v = r.GetValue(i);
        return v switch
        {
            DateTimeOffset dto => dto,
            // A naive LIS datetime — attach IST rather than letting it be read
            // as UTC. See Domain/NobleTime.
            DateTime dt => Domain.NobleTime.ToIst(DateTime.SpecifyKind(dt, DateTimeKind.Unspecified)),
            _ => null,
        };
    }

    public static bool? GetOrdinalNullableBool(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        if (r.IsDBNull(i)) return null;
        var v = r.GetValue(i);
        return v switch
        {
            bool b => b,
            int n => n != 0,
            byte b => b != 0,
            short s => s != 0,
            _ => null,
        };
    }
}
