namespace Infinity.Api.Data;

/// <summary>
/// A page of rows together with the size of the whole matching set.
///
/// Every list endpoint in Infinity returns this shape. The rule it encodes:
/// a caller must never have to infer whether more rows exist. Inferring it from
/// a full page is wrong whenever the total divides evenly by the page size, and
/// a bare row cap is worse still — it presents a truncated list as a complete
/// one, which is how a worklist of 2,129 outstanding samples showed as six.
/// </summary>
/// <param name="Total">
/// Rows matching the filters, NOT rows in this page.
/// </param>
public sealed record Paged<T>(IReadOnlyList<T> Rows, int Total, int Page, int PageSize)
{
    public int PageCount => PageSize > 0 ? (Total + PageSize - 1) / PageSize : 0;

    /// <summary>Clamp a requested page/size to something the database will accept.</summary>
    public static (int Page, int Size) Clamp(int page, int pageSize, int defaultSize, int maxSize = 1000) =>
        (Math.Max(page, 1), pageSize is < 1 ? defaultSize : Math.Min(pageSize, maxSize));
}
