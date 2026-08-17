using Npgsql;

namespace Stellar.Sync;

/// <summary>
/// Resolves the staged <c>*_noble_id</c> columns into real surrogate FKs.
///
/// A SEPARATE PASS, run after every sync cycle, rather than inside each
/// table's Apply — which is where it started and where it was wrong.
///
/// The bug: resolution inside Apply only happens when rows flow. On the first
/// run the centre snapshot failed (a parameter-count overflow) and lab_user
/// loaded against an empty centre table, resolving nothing. Every later run
/// found no lab_user changes, so Apply never ran, so the FKs stayed NULL
/// forever — 3,590 users permanently detached from centres that were sitting
/// right there.
///
/// As its own idempotent pass this cannot happen: whenever a parent arrives,
/// the next cycle attaches whatever was waiting for it. Each statement is
/// guarded by `IS NULL` on the target, so it only touches rows that still need
/// resolving and costs nothing once the backlog is clear.
/// </summary>
internal static class Resolver
{
    private static readonly (string Name, string Sql)[] Steps =
    [
        ("test.specimen_type", """
            UPDATE stellar.test t SET specimen_type_id = s.id
            FROM stellar.specimen_type s
            WHERE s.noble_id = t.specimen_noble_id AND t.specimen_type_id IS NULL
            """),

        ("lab_user.centre", """
            UPDATE stellar.lab_user u SET centre_id = c.id
            FROM stellar.centre c
            WHERE c.noble_id = u.centre_noble_id AND u.centre_id IS NULL
            """),

        ("registration.centre", """
            UPDATE stellar.registration r SET centre_id = c.id
            FROM stellar.centre c
            WHERE c.noble_id = r.centre_noble_id AND r.centre_id IS NULL
            """),

        ("registration.doctor", """
            UPDATE stellar.registration r SET referring_doctor_id = f.id
            FROM stellar.referrer f
            WHERE f.kind = 'doctor' AND f.noble_id = r.ref_doctor_noble_id
              AND r.referring_doctor_id IS NULL
            """),

        ("registration.customer", """
            UPDATE stellar.registration r SET referring_customer_id = f.id
            FROM stellar.referrer f
            WHERE f.kind = 'customer' AND f.noble_id = r.ref_customer_noble_id
              AND r.referring_customer_id IS NULL
            """),

        ("sample.registration", """
            UPDATE stellar.sample s SET registration_id = r.id
            FROM stellar.registration r
            WHERE r.noble_id = s.registration_noble_id AND s.registration_id IS NULL
            """),

        ("sample.specimen_type", """
            UPDATE stellar.sample s SET specimen_type_id = st.id
            FROM stellar.specimen_type st
            WHERE st.noble_id = s.specimen_noble_id AND s.specimen_type_id IS NULL
            """),

        ("ordered_test.registration", """
            UPDATE stellar.ordered_test o SET registration_id = r.id
            FROM stellar.registration r
            WHERE r.noble_id = o.registration_noble_id AND o.registration_id IS NULL
            """),

        ("ordered_test.test", """
            UPDATE stellar.ordered_test o SET test_id = t.id
            FROM stellar.test t
            WHERE t.noble_id = o.test_noble_id AND o.test_id IS NULL
            """),

        ("bill.centre", """
            UPDATE stellar.bill b SET centre_id = c.id
            FROM stellar.centre c
            WHERE c.noble_id = b.centre_noble_id AND b.centre_id IS NULL
            """),

        ("bill_line.bill", """
            UPDATE stellar.bill_line l SET bill_id = b.id
            FROM stellar.bill b
            WHERE b.noble_id = l.bill_noble_id AND l.bill_id IS NULL
            """),

        ("receipt.bill", """
            UPDATE stellar.receipt rc SET bill_id = b.id
            FROM stellar.bill b
            WHERE b.noble_id = rc.bill_noble_id AND rc.bill_id IS NULL
            """),

        ("account_entry.centre", """
            UPDATE stellar.account_entry a SET centre_id = c.id
            FROM stellar.centre c
            WHERE c.noble_id = a.centre_noble_id AND a.centre_id IS NULL
            """),

        // Results and events reference a sample by BARCODE, not by id — that is
        // Noble's own foreign key. sid is citext, so the join is
        // case-insensitive without either side needing lower().
        // NOT by sample_vailid — that column holds a patient name in Noble, not
        // a barcode, and the join it invites matches nothing. See the warning
        // on ClinicalTables.SampleEvent.
        ("sample_event.registration", """
            UPDATE stellar.sample_event e SET registration_id = r.id
            FROM stellar.registration r
            WHERE r.noble_id = e.registration_noble_id AND e.registration_id IS NULL
            """),

        ("sample_event.centre", """
            UPDATE stellar.sample_event e SET centre_id = c.id
            FROM stellar.centre c
            WHERE c.noble_id = e.centre_noble_id AND e.centre_id IS NULL
            """),

        ("result.sample", """
            UPDATE stellar.result r SET sample_id = s.id
            FROM stellar.sample s
            WHERE s.sid = r.sample_vailid AND r.sample_id IS NULL
            """),

        ("result.test", """
            UPDATE stellar.result r SET test_id = t.id
            FROM stellar.test t
            WHERE t.noble_id = r.test_noble_id AND r.test_id IS NULL
            """),
    ];

    public static async Task<int> RunAsync(
        NpgsqlConnection pg, ILogger log, CancellationToken ct)
    {
        var total = 0;
        foreach (var (name, sql) in Steps)
        {
            await using var cmd = new NpgsqlCommand(sql, pg) { CommandTimeout = 600 };
            var n = await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            if (n > 0)
            {
                log.LogInformation("resolved {Count} {Step}", n, name);
                total += n;
            }
        }
        return total;
    }
}
