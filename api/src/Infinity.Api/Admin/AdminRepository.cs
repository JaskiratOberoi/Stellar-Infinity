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
