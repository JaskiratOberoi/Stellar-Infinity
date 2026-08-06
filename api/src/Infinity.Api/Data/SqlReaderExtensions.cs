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

    /// <summary>
    /// A money column that may genuinely have no value.
    ///
    /// Distinct from <see cref="Dec"/>, which folds NULL to zero. For a rate
    /// that is the wrong answer: "this client has no price for this item" and
    /// "this item is free" are different facts, and collapsing them would put a
    /// zero-rupee line on a bill.
    /// </summary>
    public static decimal? NullableDec(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : Convert.ToDecimal(r.GetValue(i));
    }

    public static bool Bool(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return !r.IsDBNull(i) && Convert.ToBoolean(r.GetValue(i));
    }

    /// <summary>
    /// A flag whose NULL means "not decided" rather than "off".
    ///
    /// The invoice toggles are the case: an unconfigured client must fall back
    /// to a per-client default, and folding NULL to false would quietly drop
    /// the billed-not-performed disclaimer from every invoice nobody has
    /// configured — which is most of them.
    /// </summary>
    public static bool? NullableBool(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : Convert.ToBoolean(r.GetValue(i));
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
