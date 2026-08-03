namespace Infinity.Api.Domain;

/// <summary>
/// Noble stores every <c>datetime</c> column as IST wall-clock with no timezone
/// information attached. Getting this wrong is the single easiest way to ship a
/// report with times 5.5 hours out, so all conversion goes through here.
///
/// How the driver behaves: Microsoft.Data.SqlClient returns <c>datetime</c> as a
/// <see cref="DateTime"/> with <see cref="DateTimeKind.Unspecified"/> — it does
/// NOT convert. That is the correct, safe default (Node's mssql driver assumes
/// UTC unless you pass <c>useUTC:false</c>, which is the bug Telo had to pin
/// around). The remaining risk is downstream: calling
/// <see cref="DateTime.ToUniversalTime"/> on an Unspecified value makes .NET
/// assume it is *server local* time, which on a UTC container is wrong by 5.5h.
///
/// Rule: never call ToUniversalTime()/ToLocalTime() on a value read from Noble.
/// Call <see cref="ToIst"/> to attach the correct offset, and serialize the
/// resulting <see cref="DateTimeOffset"/>.
///
/// Note this deliberately diverges from Telo, which emits the naive IST
/// wall-clock re-stamped with a literal 'Z' (see its lib/datetime.ts "Listec
/// convention"). That works only because its frontend formatter knows to undo
/// the lie. Emitting a real +05:30 offset is unambiguous for any client, so
/// Infinity does that instead. If you ever need to interop with a Telo-format
/// payload, use <see cref="ToListecLegacyString"/> and comment why.
/// </summary>
public static class NobleTime
{
    /// <summary>IST is UTC+05:30 year-round; India has never observed DST.</summary>
    public static readonly TimeSpan IstOffset = TimeSpan.FromMinutes(330);

    /// <summary>
    /// Attach the correct IST offset to a naive datetime read from Noble.
    /// Throws if handed a value that already carries a Kind, because that means
    /// it did not come straight from the database and the caller is guessing.
    /// </summary>
    public static DateTimeOffset ToIst(DateTime naive)
    {
        if (naive.Kind != DateTimeKind.Unspecified)
        {
            throw new ArgumentException(
                $"Expected an Unspecified DateTime straight from Noble, got Kind={naive.Kind}. " +
                "Something has already converted this value; fix the read path rather than re-tagging it here.",
                nameof(naive));
        }

        return new DateTimeOffset(naive, IstOffset);
    }

    /// <inheritdoc cref="ToIst(DateTime)"/>
    public static DateTimeOffset? ToIst(DateTime? naive) => naive is null ? null : ToIst(naive.Value);

    /// <summary>
    /// Current IST wall-clock, shaped for writing back into a Noble
    /// <c>datetime</c> column. Note the LIS itself stamps most audit columns
    /// with <c>GETDATE()</c> server-side — prefer that where an SP allows it, so
    /// the clock of record stays the database's.
    /// </summary>
    public static DateTime NowForNoble() =>
        DateTime.SpecifyKind(DateTimeOffset.UtcNow.ToOffset(IstOffset).DateTime, DateTimeKind.Unspecified);

    /// <summary>
    /// Telo/Listec legacy wire format: the IST wall-clock rendered as ISO 8601
    /// and stamped 'Z' even though it is not UTC. Only for payloads consumed by
    /// Telo's frontend formatter — never for new Infinity endpoints.
    /// </summary>
    public static string? ToListecLegacyString(DateTime? naive) =>
        naive?.ToString("yyyy-MM-ddTHH:mm:ss.fff") is { } s ? s + "Z" : null;
}
