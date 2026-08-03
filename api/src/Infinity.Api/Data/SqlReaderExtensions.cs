using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reads;

/// <summary>
/// Shared, null-tolerant column readers for the read repositories.
///
/// Deliberately one class in one namespace: two repositories each defining
/// their own <c>Int</c>/<c>Dec</c>/<c>Str</c> extensions is an ambiguous-call
/// compile error, and the near-miss version (slightly different behaviour in
/// each) is worse — it silently diverges.
///
/// Noble's legacy columns are inconsistently typed (an id may be int or bigint,
/// a numeric may arrive as a string), so these convert defensively rather than
/// trusting the declared type.
/// </summary>
internal static class SqlReaderExtensions
{
    public static int Int(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? 0 : Convert.ToInt32(r.GetValue(i));
    }

    public static int? NullableInt(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : Convert.ToInt32(r.GetValue(i));
    }

    public static decimal Dec(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? 0m : Convert.ToDecimal(r.GetValue(i));
    }

    public static string? Str(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetValue(i)?.ToString();
    }

    public static DateTime? Date(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetDateTime(i);
    }
}
