using System.Data;
using Infinity.Api.Data;

namespace Infinity.Api.Orders;

/// <summary>
/// Charges the custom lines (the Smart Report) the legacy LIS's Register
/// button walked past.
/// </summary>
/// <remarks>
/// <para>
/// A custom line is charged to the centre's account when the order's first
/// sample is registered — by the accession procedure Infinity and Telo call.
/// The LIS's own Register knows nothing of custom lines, so an order booked
/// here with a Smart Report and received at the bench through the LIS was
/// charged for its tests and never for the booklet. Found on 2026-09-24:
/// two such lines with their tests charged and the extra not.
/// </para>
/// <para>
/// This runs <c>usp_inf_custom_line_sweep</c> every ten minutes: every patient
/// with an unlatched line whose sample the lab has received is charged
/// through the same procedure the accession path uses, as the user who
/// placed the order. The procedure is idempotent and leaves lines from
/// before 2026-09-21 alone (a parked decision, not an oversight). Failures
/// are logged and retried on the next pass; nothing here can fail a request.
/// </para>
/// </remarks>
public sealed class CustomLineSweep(NobleConnectionFactory db, ILogger<CustomLineSweep> logger) : BackgroundService
{
    private static readonly TimeSpan FirstDelay = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan Every = TimeSpan.FromMinutes(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(FirstDelay, stoppingToken).ConfigureAwait(false); }
        catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var (charged, total, patients) = await db.QueryAsync("sweep.customLines", async (conn, ct) =>
                {
                    await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_custom_line_sweep");
                    cmd.CommandTimeout = 120;
                    var pCharged = cmd.Parameters.Add("@charged", SqlDbType.Int);
                    pCharged.Direction = ParameterDirection.Output;
                    var pTotal = cmd.Parameters.Add("@charge_total", SqlDbType.Int);
                    pTotal.Direction = ParameterDirection.Output;
                    var pPatients = cmd.Parameters.Add("@patients", SqlDbType.Int);
                    pPatients.Direction = ParameterDirection.Output;
                    await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
                    return (pCharged.Value as int? ?? 0, pTotal.Value as int? ?? 0, pPatients.Value as int? ?? 0);
                }, stoppingToken).ConfigureAwait(false);

                if (charged > 0)
                {
                    logger.LogInformation("customLines.swept lines={Lines} rupees={Total} patients={Patients}",
                        charged, total, patients);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "customLines.sweep failed; will retry in {Minutes} min", Every.TotalMinutes);
            }

            try { await Task.Delay(Every, stoppingToken).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }
}
