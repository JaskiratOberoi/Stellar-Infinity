using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <summary>
/// What a report may carry: only what has been authorised.
/// </summary>
/// <remarks>
/// The legacy LIS releases a sample from Partially Authorised (6) onward and
/// prints the rows with the authorised bit set — GET_PATIENT_REPORT_VAIL_ID
/// takes <c>sample_status IN (6,7,8,9) AND auth = 1</c>. Infinity does the
/// same, with one refinement the raw bit needs: on a real sample the Head and
/// Profile rows carry NO bit (they are structure, not results — a CBC's
/// "Automated 5 Part Analyzer" head is auth=0 while its parameters are
/// auth=1), so filtering on the bit alone drops every heading and prints the
/// values as an unlabelled list. Headings are therefore kept, and dropped only
/// when everything under them was dropped: a Head whose parameters were all
/// unsigned goes with them, and a Profile whose members all went goes too. A
/// Head that never had parameters — the title over a multi-part test — stays,
/// and the print model already prints such a title only while a sub-group
/// after it prints.
///
/// Applied to BOTH report JSON routes, the signed-in one and the patient's
/// QR copy, before the rows leave the API: an unreleased value must not be
/// readable from either, whatever the page does with it.
/// </remarks>
public static class ReportRelease
{
    public static IReadOnlyList<TestResult> Releasable(IReadOnlyList<TestResult> rows)
    {
        // Nothing to do when every row is already released — the common case
        // for a fully authorised sample.
        if (rows.All(r => r.Authorized || IsHeading(r))) return rows;

        var keep = new bool[rows.Count];

        // Pass 1: values. A Param or Test row survives only if authorised.
        for (var i = 0; i < rows.Count; i++)
            keep[i] = IsHeading(rows[i]) || rows[i].Authorized;

        // Pass 2: Heads. Look ahead to the next structural row; a Head that
        // HAD parameters and kept none goes.
        for (var i = 0; i < rows.Count; i++)
        {
            if (!IsType(rows[i], "Head")) continue;
            int had = 0, kept = 0;
            for (var j = i + 1; j < rows.Count && !IsHeading(rows[j]); j++)
            {
                if (!IsType(rows[j], "Param")) continue;
                had++;
                if (keep[j]) kept++;
            }
            if (had > 0 && kept == 0) keep[i] = false;
        }

        // Pass 3: Profiles. Members share the profile's id; a Profile with no
        // surviving member goes.
        for (var i = 0; i < rows.Count; i++)
        {
            if (!IsType(rows[i], "Profile") || rows[i].ProfileId is not int pid) continue;
            var any = false;
            for (var j = 0; j < rows.Count; j++)
            {
                if (j == i || !keep[j] || rows[j].ProfileId != pid || IsType(rows[j], "Profile")) continue;
                any = true;
                break;
            }
            if (!any) keep[i] = false;
        }

        var outList = new List<TestResult>(rows.Count);
        for (var i = 0; i < rows.Count; i++) if (keep[i]) outList.Add(rows[i]);
        return outList;
    }

    private static bool IsType(TestResult r, string type) =>
        string.Equals((r.TestType ?? string.Empty).Trim(), type, StringComparison.OrdinalIgnoreCase);

    private static bool IsHeading(TestResult r) => IsType(r, "Head") || IsType(r, "Profile");
}
