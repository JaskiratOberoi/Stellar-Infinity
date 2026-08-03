namespace Infinity.Api.Domain;

/// <summary>
/// Infinity's origin marker for rows it creates in SHARED LIS tables.
///
/// Noble is the live LIS production database. Telo already stamps every row it
/// creates with <c>addedby/createdby/receivedby = 'telo:&lt;userId&gt;'</c>, and its
/// write procedures refuse to mutate any row that is not marked that way.
/// Infinity uses its own prefix so the two systems stay distinguishable and
/// neither can corrupt the other's records — do NOT reuse Telo's.
///
/// Every Infinity write procedure must:
///   1. stamp the rows it creates with <see cref="For"/>, and
///   2. refuse to update/delete a row whose marker fails <see cref="IsOurs"/>.
///
/// Reads that should see only Infinity-created rows filter with
/// <c>addedby LIKE 'inf:%'</c> (<see cref="LikePattern"/>). Index any column you
/// filter on this way — Telo had to add an index on
/// <c>tbl_med_mcc_patient_master.mobile_number</c> for exactly this reason.
/// </summary>
public static class Origin
{
    public const string Prefix = "inf:";

    /// <summary>SQL LIKE pattern matching every Infinity-created row.</summary>
    public const string LikePattern = Prefix + "%";

    /// <summary>The marker to stamp on rows created by this user.</summary>
    public static string For(long userId) => string.Concat(Prefix, userId.ToString());

    /// <summary>True if the row was created by Infinity (any user).</summary>
    public static bool IsOurs(string? addedBy) =>
        addedBy is not null && addedBy.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The user id embedded in a marker, or null if it is not ours / malformed.
    /// </summary>
    public static long? UserIdFrom(string? addedBy) =>
        IsOurs(addedBy) && long.TryParse(addedBy!.AsSpan(Prefix.Length), out var id) ? id : null;
}
