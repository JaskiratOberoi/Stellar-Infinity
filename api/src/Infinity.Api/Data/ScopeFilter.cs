using System.Data;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Data;

/// <summary>
/// Builds the <c>mcc_code IN (...)</c> predicate that scopes every read.
///
/// Two behaviours worth knowing, both inherited from Telo:
///
///  - <b>Empty scope means NOTHING, not everything.</b> A user with no centres
///    must see zero rows. Emitting no predicate would be the opposite, and is
///    the single most dangerous bug this class can have — hence
///    <see cref="MatchesNothing"/> rather than an empty string.
///
///  - <b>Very broad scope skips the predicate.</b> SQL Server caps a statement
///    at 2,100 parameters; an admin with ~4,000 centres would blow straight
///    through it. Above the threshold the filter is a no-op anyway, because the
///    user can see every centre there is.
/// </summary>
public sealed class ScopeFilter
{
    /// <summary>Above this many centres the IN-list is pointless and unsafe to build.</summary>
    public const int UnrestrictedThreshold = 1000;

    private ScopeFilter(string predicate, bool unrestricted, bool empty)
    {
        Predicate = predicate;
        IsUnrestricted = unrestricted;
        IsEmpty = empty;
    }

    /// <summary>SQL fragment, always safe to concatenate after an existing WHERE clause.</summary>
    public string Predicate { get; }

    public bool IsUnrestricted { get; }

    /// <summary>True when the user has no centres — callers should short-circuit.</summary>
    public bool IsEmpty { get; }

    /// <summary>A predicate that can never match, for the empty-scope case.</summary>
    public static ScopeFilter MatchesNothing { get; } = new("1 = 0", false, true);

    /// <summary>
    /// Build the predicate and bind its parameters onto <paramref name="cmd"/>.
    /// </summary>
    /// <param name="column">Fully-qualified column, e.g. <c>b.mcc_code</c>.</param>
    public static ScopeFilter For(SqlCommand cmd, string column, IReadOnlyList<int> scope, string prefix = "sc")
    {
        if (scope.Count == 0) return MatchesNothing;
        if (scope.Count > UnrestrictedThreshold) return new ScopeFilter("1 = 1", true, false);

        var names = new string[scope.Count];
        for (var i = 0; i < scope.Count; i++)
        {
            var name = $"@{prefix}{i}";
            names[i] = name;
            cmd.Parameters.Add(name, SqlDbType.Int).Value = scope[i];
        }

        return new ScopeFilter($"{column} IN ({string.Join(',', names)})", false, false);
    }
}
