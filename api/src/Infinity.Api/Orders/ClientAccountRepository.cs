using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Orders;

/// <param name="Balance">
/// The raw account value, for reconciling against the LIS. NEGATIVE means the
/// client owes the lab — orders debit this account and payments credit it.
/// </param>
/// <param name="Owed">
/// The same number the way a person reads it: positive when money is due. The
/// sign flip happens once, in SQL, rather than in every screen that shows it.
/// </param>
public sealed record ClientAccount(
    int MccId,
    string? ClientCode,
    string? ClientName,
    bool IsActive,
    decimal Balance,
    decimal Owed,
    decimal TotalDeposited,
    DateTimeOffset? LastUpdatedAt,
    /// <summary>The LIS allowance, stored NEGATIVE: -2500 = may owe up to 2,500.</summary>
    decimal CreditLimit = 0,
    /// <summary>The master switch — reports released however much is owed.</summary>
    bool Unlocked = false,
    /// <summary>A time-boxed release granted in the legacy LIS, still running.</summary>
    bool TempUnlocked = false,
    /// <summary>Whether reports are actually being withheld right now.</summary>
    bool ReportsLocked = false);

/// <param name="Changed">False when the flag already stood that way.</param>
public sealed record UnlockResult(
    bool Ok, string? ErrorCode, string? Message,
    string? ClientCode, string? ClientName,
    bool Unlocked, bool WasUnlocked, bool Changed,
    decimal Balance, decimal CreditLimit);

/// <param name="Direction">debit (an order consumed credit) | credit (a payment came in)</param>
/// <param name="Origin">infinity | telo | lis — which system posted it.</param>
public sealed record LedgerEntry(
    int Id,
    DateTimeOffset? OccurredAt,
    decimal Amount,
    string Direction,
    string? Note,
    string? Reference,
    string? AddedBy,
    string Origin,
    DateTimeOffset? PostedAt);

/// <param name="NewBalance">
/// The account after the payment, or null when it was rejected — the procedure
/// returns NULL on every failure path.
/// </param>
public sealed record PaymentResult(bool Ok, string? ErrorCode, string? Message, decimal? NewBalance);

/// <summary>
/// Client accounts: what each owes, and the movements behind it.
///
/// Reads only. Money MOVES through Telo's procedures — usp_telo_post_ledger and
/// usp_telo_record_mcc_payment, both now origin-parameterised — for the same
/// reason order creation does: they already hold the rules, and two
/// implementations posting to one ledger would eventually disagree about a
/// balance.
/// </summary>
public sealed class ClientAccountRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public Task<Paged<ClientAccount>> ListAsync(
        IReadOnlyList<string> clientCodes, string? search, bool onlyOwing,
        int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("accounts.list", token =>
            db.QueryAsync("accounts.list", async (conn, inner) =>
            {
                var (p, size) = Paged<ClientAccount>.Clamp(page, pageSize, 100);

                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_client_accounts");
                AddCodesTvp(cmd, clientCodes);
                cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value =
                    string.IsNullOrWhiteSpace(search) ? DBNull.Value : search.Trim();
                cmd.Parameters.Add("@only_owing", SqlDbType.Bit).Value = onlyOwing;
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = p;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<ClientAccount>();
                var total = 0;
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (rows.Count == 0) total = r.NullableInt("total_count") ?? 0;

                    rows.Add(new ClientAccount(
                        MccId: r.Int("mccId"),
                        ClientCode: r.Str("clientCode"),
                        ClientName: r.Str("clientName"),
                        IsActive: (r.NullableInt("isActive") ?? 0) == 1,
                        Balance: r.Dec("balance"),
                        Owed: r.Dec("owed"),
                        TotalDeposited: r.Dec("totalDeposited"),
                        LastUpdatedAt: Domain.NobleTime.ToIst(r.Date("lastUpdatedAt")),
                        CreditLimit: r.Dec("creditLimit"),
                        Unlocked: r.Bool("unlocked"),
                        TempUnlocked: r.Bool("tempUnlocked"),
                        ReportsLocked: r.Bool("reportsLocked")));
                }

                return new Paged<ClientAccount>(rows, total, p, size);
            }, token), ct);

    public Task<Paged<LedgerEntry>> LedgerAsync(
        int mcc, int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("accounts.ledger", token =>
            db.QueryAsync("accounts.ledger", async (conn, inner) =>
            {
                var (p, size) = Paged<LedgerEntry>.Clamp(page, pageSize, 100);

                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_client_ledger");
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = p;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<LedgerEntry>();
                var total = 0;
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (rows.Count == 0) total = r.NullableInt("total_count") ?? 0;

                    rows.Add(new LedgerEntry(
                        Id: r.Int("id"),
                        OccurredAt: Domain.NobleTime.ToIst(r.Date("occurredAt")),
                        Amount: r.Dec("amount"),
                        Direction: r.Str("direction") ?? "debit",
                        Note: r.Str("note"),
                        Reference: r.Str("reference"),
                        AddedBy: r.Str("addedby"),
                        Origin: r.Str("origin") ?? "lis",
                        PostedAt: Domain.NobleTime.ToIst(r.Date("postedAt"))));
                }

                return new Paged<LedgerEntry>(rows, total, p, size);
            }, token), ct);

    /// <summary>
    /// Grant or revoke the master unlock for one client.
    /// </summary>
    /// <remarks>
    /// Writes the LIS's own PerminentUnlock bit, so a client released here is
    /// released in Telo and the legacy LIS too — see the header of
    /// 120_client_report_unlock.sql on why that is deliberate rather than a
    /// leak. Not retried: it is a deliberate, audited act, and replaying it
    /// after a timeout would write a second audit row for one decision.
    /// </remarks>
    public Task<UnlockResult> SetUnlockAsync(
        int mcc, bool unlocked, string? reason,
        int actorUserId, string? actorUsername, CancellationToken ct = default) =>
        db.QueryAsync("accounts.setUnlock", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_set_client_unlock");
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@unlocked", SqlDbType.Bit).Value = unlocked;
            cmd.Parameters.Add("@reason", SqlDbType.NVarChar, 400).Value =
                string.IsNullOrWhiteSpace(reason) ? DBNull.Value : reason.Trim();
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = actorUserId;
            cmd.Parameters.Add("@actor_username", SqlDbType.NVarChar, 100).Value =
                (object?)actorUsername ?? DBNull.Value;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new UnlockResult(false, "NO_RESULT", "The database returned nothing.",
                                        null, null, false, false, false, 0, 0);

            var ok = r.Bool("ok");
            if (!ok)
                return new UnlockResult(false, r.Str("error_code"), r.Str("message"),
                                        null, null, false, false, false, 0, 0);

            return new UnlockResult(
                true, null, null,
                r.Str("client_code"), r.Str("client_name"),
                r.Bool("unlocked"), r.Bool("was_unlocked"), r.Bool("changed"),
                r.Dec("balance"), r.Dec("credit_limit"));
        }, ct);

    /// <summary>
    /// Record a payment from a client against their account.
    ///
    /// NOT retried. This moves money: it credits the running balance and
    /// appends a ledger row, and a replay after a timeout would credit them
    /// twice. A caller that times out must check the ledger, not try again.
    /// </summary>
    public Task<PaymentResult> RecordPaymentAsync(
        int userId, int mcc, int amount, int mode, string? chequeNo, string? reason,
        CancellationToken ct = default) =>
        db.QueryAsync("accounts.pay", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_record_mcc_payment");
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@amount", SqlDbType.Int).Value = amount;
            cmd.Parameters.Add("@mode", SqlDbType.Int).Value = mode;
            cmd.Parameters.Add("@depositDate", SqlDbType.VarChar, 10).Value = DBNull.Value;
            cmd.Parameters.Add("@chequeNo", SqlDbType.NVarChar, 50).Value =
                string.IsNullOrWhiteSpace(chequeNo) ? DBNull.Value : chequeNo.Trim();
            cmd.Parameters.Add("@reason", SqlDbType.NVarChar, 200).Value =
                string.IsNullOrWhiteSpace(reason) ? DBNull.Value : reason.Trim();
            // Telo commit fa5568c added this. Without it the payment would be
            // recorded as Telo's.
            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 20).Value = "inf:";

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new PaymentResult(
                    (r.NullableInt("ok") ?? 0) == 1,
                    r.Str("error_code"),
                    r.Str("message"),
                    // The column is new_balance, and it is NULL on every failure
                    // path. Nullable rather than Dec(): folding that to 0 would
                    // report a rejected payment as having zeroed the account.
                    r.NullableDec("new_balance"));
            }

            return new PaymentResult(false, "NO_RESULT", "The payment procedure returned nothing.", null);
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
