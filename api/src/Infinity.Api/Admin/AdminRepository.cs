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
    int SessionVersion,
    /// <summary>
    /// Walk-in ordering granted to this user individually (order:b2c).
    ///
    /// A client account is B2B-only by default; the lab turns this on for the
    /// few centres that take walk-in patients. Reported as the GRANT, not as
    /// the effective capability, because a lab role holds order:b2c anyway and
    /// the panel must show a toggle, not a coincidence.
    /// </summary>
    bool WalkInGranted,
    /// <summary>
    /// The price veil (rate:hidden) granted to this user individually — the
    /// order form, preview and catalogue hide every rate. Reported as the
    /// grant, like WalkInGranted, so the panel shows a toggle rather than a
    /// coincidence (the sub_client role holds it inherently).
    /// </summary>
    bool RatesHidden = false);

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
            var walkIn = new HashSet<int>();
            var ratesHidden = new HashSet<int>();

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
                    SessionVersion: reader.GetOrdinalInt32("session_version") ?? 0,
                    // Filled in after the reader closes; see below.
                    WalkInGranted: false));

                total = reader.GetOrdinalInt32("total_count") ?? total;
            }

            await reader.CloseAsync().ConfigureAwait(false);

            /* Which of THESE users hold a walk-in grant.
             *
             * One query for the page rather than one per row, and only for
             * the ids actually listed: the grant table is small but the user
             * list is not, and a per-row lookup on a 50-row page would be 50
             * round trips to render one column.
             *
             * The id list is built from INTEGERS already read out of the
             * database, not from anything a caller sent, so the interpolation
             * carries nothing a parameter would protect. */
            if (rows.Count > 0)
            {
                var ids = string.Join(",", rows.Select(r => r.UserId));
                // Both per-user grants for the page in one pass — same table,
                // same id list, two capabilities.
                await using var g = new SqlCommand(
                    "SELECT user_id, capability FROM dbo.inf_user_capability_grant " +
                    "WHERE capability IN ('order:b2c', 'rate:hidden') AND user_id IN (" + ids + ")", conn);
                await using var gr = await g.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await gr.ReadAsync(inner).ConfigureAwait(false))
                {
                    var uid = gr.GetInt32(0);
                    if (gr.GetString(1) == "rate:hidden") ratesHidden.Add(uid); else walkIn.Add(uid);
                }
            }

            for (var i = 0; i < rows.Count; i++)
            {
                rows[i] = rows[i] with
                {
                    WalkInGranted = walkIn.Contains(rows[i].UserId),
                    RatesHidden = ratesHidden.Contains(rows[i].UserId),
                };
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

            // The reader is fully consumed, but `await using` would keep it
            // OPEN until the method returns — and the grants query below needs
            // this same connection, which allows one reader at a time. Close
            // it now; the scope-exit dispose on an already-closed reader is a
            // no-op. Without this, every Settings click answered 500.
            await r.DisposeAsync().ConfigureAwait(false);

            // One extra round trip on a single-user admin screen, rather than a
            // fourth result set in procedure 61 — the procedure is shared and
            // this keeps the change to Infinity's own side.
            var grants = await CapabilityGrantsAsync(userId, conn, inner).ConfigureAwait(false);

            return new AdminUserDetail(
                head.UserId, head.Username, head.FirstName, head.LastName, head.Email,
                head.UsertypeId, head.UsertypeName, head.PccId, head.SubPccId, head.BusinessUnitId,
                head.LisIsActive, head.ManagedBy, head.InfinityActive, head.InfinityLisAccess,
                explicitRole, effectiveRole,
                // The role's capabilities UNION anything granted to this user
                // individually, so the panel shows what the person actually
                // has rather than what their role alone would give.
                InfinityRoles.CapabilitiesFor(effectiveRole).Concat(grants)
                             .Distinct(StringComparer.Ordinal)
                             .OrderBy(c => c, StringComparer.Ordinal).ToArray(),
                head.SessionVersion, head.Lis, grants, codes, own);
        }, ct);

    /// <summary>Per-user capability grants. See dbo.inf_user_capability_grant.</summary>
    private static async Task<IReadOnlyList<string>> CapabilityGrantsAsync(
        int userId, SqlConnection conn, CancellationToken ct)
    {
        await using var cmd = new SqlCommand(
            "SELECT capability FROM dbo.inf_user_capability_grant WHERE user_id = @uid", conn);
        cmd.Parameters.Add("@uid", SqlDbType.Int).Value = userId;
        var list = new List<string>();
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false)) list.Add(r.GetString(0));
        return list;
    }

    /// <summary>
    /// Grant or revoke ONE capability for ONE user. The grantable set is a
    /// CHECK constraint on the table, not a value this layer chooses.
    /// </summary>
    public Task<SpResult> SetCapabilityGrantAsync(
        int userId, string capability, bool granted, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.setCapabilityGrant", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_set_capability_grant");
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@capability", SqlDbType.VarChar, 40).Value = capability;
            cmd.Parameters.Add("@granted", SqlDbType.Bit).Value = granted;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;
            return await ReadSpResultAsync(cmd, inner).ConfigureAwait(false);
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

    /// <summary>
    /// Reveal the current (plaintext) password. Possible only because the LIS
    /// credential column is plaintext; every reveal is audited by the caller.
    /// Returns the password on the SpResult's Message-adjacent channel via a
    /// dedicated column, so a null-but-ok answer is distinguishable from a
    /// guard refusal.
    /// </summary>
    public Task<(SpResult Result, string? Password)> ViewPasswordAsync(
        int userId, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.viewPassword", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_view_password");
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return (new SpResult(false, "INTERNAL", "The operation returned no result."), (string?)null);
            var result = new SpResult(r.GetOrdinalBool("ok"), r.GetOrdinalString("error_code"), r.GetOrdinalString("message"));
            return (result, r.GetOrdinalString("password"));
        }, ct);

    public Task<SpResult> SetPermanentUnlockAsync(int mcc, bool enabled, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.setPermanentUnlock", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_set_permanent_unlock");
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@enabled", SqlDbType.Bit).Value = enabled;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;
            return await ReadSpResultAsync(cmd, inner).ConfigureAwait(false);
        }, ct);

    public Task<(SpResult Result, DateTimeOffset? Expire)> GrantTempUnlockAsync(
        int mcc, int hours, int actor, CancellationToken ct = default) =>
        db.QueryAsync("admin.grantTempUnlock", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_grant_temp_unlock");
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@hours", SqlDbType.Int).Value = hours;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return (new SpResult(false, "INTERNAL", "The operation returned no result."), (DateTimeOffset?)null);
            var result = new SpResult(r.GetOrdinalBool("ok"), r.GetOrdinalString("error_code"), r.GetOrdinalString("message"));
            return (result, r.GetOrdinalDateTimeOffset("expire_unlock"));
        }, ct);

    /// <summary>Lock posture for a set of centres (comma list of unit ids).</summary>
    public Task<IReadOnlyList<CentreLockState>> CentreLockStatesAsync(
        IEnumerable<int> mccIds, CancellationToken ct = default) =>
        db.QueryAsync("admin.centreLockState", async (conn, inner) =>
        {
            var ids = string.Join(",", mccIds.Distinct());
            var list = new List<CentreLockState>();
            if (ids.Length == 0) return (IReadOnlyList<CentreLockState>)list;

            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_admin_centre_lock_state");
            cmd.Parameters.Add("@mccIds", SqlDbType.NVarChar, -1).Value = ids;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                list.Add(new CentreLockState(
                    r.GetOrdinalInt32("mcc_id") ?? 0,
                    r.GetOrdinalString("code"),
                    r.GetOrdinalString("name"),
                    r.GetOrdinalBool("permanent"),
                    r.GetOrdinalInt32("credit_limit"),
                    // Convert.ToDecimal, not GetDecimal: the balance column is
                    // not guaranteed to be a SQL decimal (ReportLockRepository
                    // reads it the same defensive way).
                    r.IsDBNull(r.GetOrdinal("current_balance"))
                        ? null : Convert.ToDecimal(r.GetValue(r.GetOrdinal("current_balance"))),
                    r.GetOrdinalDateTimeOffset("temp_expire")));
            }
            return (IReadOnlyList<CentreLockState>)list;
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
