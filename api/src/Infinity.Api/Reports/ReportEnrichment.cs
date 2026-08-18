using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <summary>
/// Fills in the two catalogue-held details a result row is printed with but is
/// not stored with: the reference range narrowed to this patient's age, and an
/// interpretation held as a picture.
/// </summary>
/// <remarks>
/// Shared by the signed-in report route and the patient's token route, because
/// they print the same sheet and a range that appears on one and not the other
/// is the kind of difference someone rings the lab about.
///
/// Best-effort throughout. A report still prints with the stored range and
/// without a graph; failing the whole request because the catalogue was briefly
/// unreachable would be the wrong trade for a document someone is waiting on —
/// the same call the extras fetch makes.
/// </remarks>
public static class ReportEnrichment
{
    public static async Task<IReadOnlyList<TestResult>> ApplyAsync(
        CatalogueDetailRepository catalogue,
        WorksheetRow row,
        CancellationToken ct)
    {
        var results = row.Results;
        if (results.Count == 0) return results;

        var testIds = results.Select(r => r.TestId ?? 0).Where(id => id > 0).Distinct().ToArray();
        if (testIds.Length == 0) return results;

        // Only ask for age bands when at least one row actually stores the
        // band dump that wants narrowing. Most reports do not.
        var wantAges = results.Any(r => CatalogueDetailRepository.WantsAgeRange(r.NormalRange));

        CatalogueDetailRepository.Details details;
        try
        {
            details = await catalogue
                .GetAsync(testIds, row.Age, row.AgeUnit, wantAges, ct)
                .ConfigureAwait(false);
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            return results;
        }

        if (details.AgeRanges.Count == 0 && details.InterpretationImages.Count == 0) return results;

        var enriched = new List<TestResult>(results.Count);
        foreach (var r in results)
        {
            var tid = r.TestId ?? 0;
            if (tid <= 0) { enriched.Add(r); continue; }

            // The narrowed band replaces the stored dump ONLY where the stored
            // text asked to be narrowed. A descriptive or gendered range keeps
            // the text a technologist validated.
            var range = CatalogueDetailRepository.WantsAgeRange(r.NormalRange)
                        && details.AgeRanges.TryGetValue(tid, out var band)
                ? band
                : r.NormalRange;

            details.InterpretationImages.TryGetValue(tid, out var image);

            enriched.Add(range == r.NormalRange && image is null
                ? r
                : r with { NormalRange = range, InterpretationImage = image });
        }

        return enriched;
    }
}
