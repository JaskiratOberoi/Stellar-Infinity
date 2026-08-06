namespace Infinity.Api.Auth;

/// <summary>
/// Infinity capabilities are role-based. A user's role comes from one of two
/// places, in this order:
///
///   1. Explicit assignment in dbo.inf_user_role, set from the admin panel.
///   2. Derived in code from the user's LIS usertypeid (<see cref="LisUsertypeToRole"/>).
///
/// The second is what lets every existing LIS user sign in on day one and land
/// with a sensible permission set, without writing a single row or touching the
/// LIS schema. Unknown LIS types fall back to <c>viewer</c> — the safe default.
/// </summary>
public static class InfinityRoles
{
    public const string SuperAdmin = "super_admin";
    public const string Admin = "admin";
    public const string LabManager = "lab_manager";
    public const string Technician = "technician";
    public const string Reporting = "reporting";
    public const string Client = "client";
    public const string Viewer = "viewer";

    /// <summary>
    /// Every valid role. MUST stay in step with the IN-lists in
    /// db/sql/20_usp_inf_admin_create_user.sql and 23_usp_inf_admin_set_role.sql.
    /// Telo shipped a mismatch here once: its admin panel offered roles the
    /// stored procedure rejected, so those users could not be saved.
    /// </summary>
    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        SuperAdmin, Admin, LabManager, Technician, Reporting, Client, Viewer,
    };

    public static bool IsValid(string? role) => role is not null && All.Contains(role);

    public static readonly IReadOnlyDictionary<string, IReadOnlySet<string>> RoleCapabilities =
        new Dictionary<string, IReadOnlySet<string>>(StringComparer.Ordinal)
        {
            // ── ON THE CHANNEL CAPABILITIES ────────────────────────────────
            // Telo carries two extra ROLES for this (b2c_billing, b2b_billing)
            // because it needed to confine particular accounts to one channel.
            // Infinity does not copy those roles: a role here is already just a
            // set of capabilities, so confinement is expressed by which channel
            // caps a role holds. Adding two near-duplicate roles would also mean
            // touching the admin picker and usp_inf_admin_set_role's validation,
            // and Telo's own comments record it shipping a mismatch between
            // those exact two places once already.
            [SuperAdmin] = Caps(
                Capabilities.UserManage,
                Capabilities.OrderCreate, Capabilities.OrderView, Capabilities.OrderAccession,
                Capabilities.OrderB2c, Capabilities.OrderB2b,
                Capabilities.PatientCreate, Capabilities.PatientView,
                Capabilities.ResultEnter, Capabilities.ResultAuthorize,
                Capabilities.ResultAmend, Capabilities.ResultReopen, Capabilities.SampleReject,
                Capabilities.AutoAuthManage,
                Capabilities.ReportView, Capabilities.ReportRelease,
                Capabilities.BillingView, Capabilities.PaymentCapture, Capabilities.RateManage,
                Capabilities.AnalyticsView),

            // Everything Super Admin has except user management — the one
            // capability that can escalate privilege.
            [Admin] = Caps(
                Capabilities.OrderCreate, Capabilities.OrderView, Capabilities.OrderAccession,
                Capabilities.OrderB2c, Capabilities.OrderB2b,
                Capabilities.PatientCreate, Capabilities.PatientView,
                Capabilities.ResultEnter, Capabilities.ResultAuthorize,
                Capabilities.ResultAmend, Capabilities.ResultReopen, Capabilities.SampleReject,
                Capabilities.AutoAuthManage,
                Capabilities.ReportView, Capabilities.ReportRelease,
                Capabilities.BillingView, Capabilities.PaymentCapture, Capabilities.RateManage,
                Capabilities.AnalyticsView),

            // Amends and rejects, but NOT reopen — reversing a completed
            // sign-off stays with Admin and above.
            [LabManager] = Caps(
                Capabilities.OrderCreate, Capabilities.OrderView, Capabilities.OrderAccession,
                Capabilities.OrderB2c, Capabilities.OrderB2b,
                Capabilities.PatientCreate, Capabilities.PatientView,
                Capabilities.ResultEnter, Capabilities.ResultAuthorize,
                Capabilities.ResultAmend, Capabilities.SampleReject,
                Capabilities.ReportView, Capabilities.ReportRelease,
                Capabilities.AnalyticsView),

            // Bench work: accession samples and enter results, but never
            // authorize their own results or release a report.
            //
            // ResultAmend is included, and is safe by construction rather than
            // by trust: usp_inf_result_save refuses outright to touch a sample
            // in status 7/8/9, so the only values a technician can overwrite are
            // ones not yet signed out. Correcting a transcription error before
            // authorization is ordinary bench work, and every amend carries a
            // mandatory reason into the audit trail. Amending an AUTHORIZED
            // result still needs ResultReopen, which stops at Admin.
            [Technician] = Caps(
                Capabilities.OrderView, Capabilities.OrderAccession,
                Capabilities.PatientView,
                Capabilities.ResultEnter, Capabilities.ResultAmend,
                Capabilities.SampleReject),

            [Reporting] = Caps(
                Capabilities.ReportView, Capabilities.ReportRelease,
                Capabilities.PatientView, Capabilities.OrderView),

            // A client centre signing in with its own LIS credentials. Scope
            // (which client codes they may see) is enforced separately and is
            // what actually stops cross-client visibility.
            //
            // B2B only, which is the whole point of the role: a centre sends
            // the lab work at its negotiated rate and bills its own patient at
            // MRP. Granting B2C as well would let a client centre raise orders
            // priced at its own rate list AND keep the patient's money, which is
            // not a transaction the lab has agreed to. Telo maps LIS client
            // accounts to b2b_billing for the same reason.
            [Client] = Caps(
                Capabilities.OrderCreate, Capabilities.OrderView,
                Capabilities.OrderB2b,
                Capabilities.PatientCreate, Capabilities.PatientView,
                Capabilities.ReportView,
                Capabilities.BillingView),

            [Viewer] = Caps(
                Capabilities.OrderView, Capabilities.PatientView,
                Capabilities.BillingView, Capabilities.AnalyticsView),
        };

    /// <summary>
    /// LIS <c>tbl_med_usertypes.id</c> -> Infinity role. Ids absent from this map
    /// fall back to <see cref="Viewer"/>. Numbers mirror Telo's snapshot of the
    /// same table, so the two systems agree about who is who.
    /// </summary>
    private static readonly Dictionary<int, string> LisUsertypeMap = new()
    {
        [1] = SuperAdmin,   // Super Admin
        [5] = Admin,        // Admin
        [26] = Admin,       // Director
        [28] = Admin,       // BAS ADMIN
        [32] = Admin,       // SALES ADMIN

        [2] = Client,       // Client
        [7] = Client,       // Sub Client
        [12] = Client,      // CLIENT INVOICE

        [29] = LabManager,  // WALKIN CODES
        [33] = LabManager,  // ENTRY

        [4] = Technician,   // Technician
        [9] = Technician,   // Molecular
        [16] = Technician,  // PHLEBOTOMIST
        [17] = Technician,  // HISTO TECH
        [18] = Technician,  // AUTHORISED
        [20] = Technician,  // ACCESSIONING
        [25] = Technician,  // SPL MOLECULR
        [30] = Technician,  // TECH ONLY
        [34] = Technician,  // HLD ACCESSION
    };

    public static string LisUsertypeToRole(int? lisUsertypeId) =>
        lisUsertypeId is int id && LisUsertypeMap.TryGetValue(id, out var role) ? role : Viewer;

    /// <summary>Explicit assignment wins; otherwise derive from the LIS user type.</summary>
    public static string Resolve(string? explicitRole, int? lisUsertypeId) =>
        IsValid(explicitRole) ? explicitRole! : LisUsertypeToRole(lisUsertypeId);

    /// <summary>
    /// Roles that may view reports for EVERY client code, rather than only the
    /// centres mapped to their account.
    ///
    /// This exists because the report-scope SQL has no unrestricted branch: it
    /// is deliberately "admin-assigned mappings ∪ own centre" for every LIS
    /// usertype, so that a CLIENT REPORTING user actually receives the codes an
    /// admin granted them. Applied to an administrator that same rule resolves
    /// to ZERO centres — no mappings, no own centre — and the worksheet goes
    /// blank while orders still work.
    ///
    /// Telo makes the same split, in lib/reportScope.ts rather than in SQL.
    /// Porting only the SQL half is what produced the blank worksheet.
    ///
    /// <c>client</c> is deliberately ABSENT and must stay absent: a client
    /// account holds report:view, and admitting it here would show every
    /// client's patients to every client.
    /// </summary>
    public static readonly IReadOnlySet<string> UnrestrictedReporters =
        new HashSet<string>(StringComparer.Ordinal) { SuperAdmin, Admin, LabManager, Reporting };

    public static bool IsUnrestrictedReporter(string? role) =>
        role is not null && UnrestrictedReporters.Contains(role);

    public static IReadOnlySet<string> CapabilitiesFor(string role) =>
        RoleCapabilities.TryGetValue(role, out var caps) ? caps : RoleCapabilities[Viewer];

    private static IReadOnlySet<string> Caps(params string[] caps) =>
        new HashSet<string>(caps, StringComparer.Ordinal);
}

public static class Capabilities
{
    public const string UserManage = "user:manage";
    public const string OrderCreate = "order:create";
    public const string OrderView = "order:view";
    public const string OrderAccession = "order:accession";

    /// <summary>
    /// The walk-in channel: the order is priced at the client's own rate —
    /// special rate, else rate list, else MRP.
    /// </summary>
    /// <remarks>
    /// Separate from <see cref="OrderCreate"/> because the two channels decide
    /// DIFFERENT AMOUNTS for the same basket, and an account should be able to
    /// hold one without the other. Telo draws the same line and confines some
    /// accounts to a single channel — an internal counter that never raises a
    /// B2B order, a client centre that only ever does.
    /// </remarks>
    public const string OrderB2c = "order:b2c";

    /// <summary>
    /// The client channel: the bill is raised at catalogue MRP, which is what
    /// the patient pays the collection centre. The centre's own cost is the
    /// rate-list price and the difference is its margin.
    /// </summary>
    /// <remarks>
    /// Holding this is the difference between billing a basket at a client's
    /// negotiated rate and billing it at full MRP, so it is a capability in its
    /// own right rather than a UI toggle.
    /// </remarks>
    public const string OrderB2b = "order:b2b";
    public const string PatientCreate = "patient:create";
    public const string PatientView = "patient:view";
    public const string ResultEnter = "result:enter";
    public const string ResultAuthorize = "result:authorize";

    /// <summary>
    /// Overwriting an EXISTING result value. Deliberately separate from
    /// <see cref="ResultEnter"/> — this is the legacy Result_Edit flag, and it
    /// is the gate that should have stopped the legacy defect where any user
    /// could overwrite an authorised value in place. Lab Manager and above.
    /// </summary>
    public const string ResultAmend = "result:amend";

    /// <summary>
    /// Re-opening an authorised sample. Strictly ABOVE
    /// <see cref="ResultAuthorize"/>: authorising is routine, reversing a
    /// sign-off is not. Requires a structured reason and writes an amendment
    /// record. In the legacy system this needed only a non-empty string.
    /// </summary>
    public const string ResultReopen = "result:reopen";

    /// <summary>The legacy Reject_Sample flag, which was never reachable in its UI.</summary>
    public const string SampleReject = "sample:reject";

    /// <summary>
    /// Turning auto-authorization on or off for a test, profile or department.
    /// Admin and above ONLY, and additionally gated by a separate password the
    /// API verifies before it will call usp_inf_auto_auth_set — this is the one
    /// setting that lets results reach a patient without a person reading them,
    /// so holding the capability is necessary but not sufficient.
    /// </summary>
    public const string AutoAuthManage = "autoauth:manage";
    public const string ReportView = "report:view";
    public const string ReportRelease = "report:release";
    public const string BillingView = "billing:view";
    public const string PaymentCapture = "payment:capture";

    /// <summary>
    /// Create rate lists and set the prices in them.
    ///
    /// Its own capability rather than folded into billing:view or user:manage.
    /// Reading what a client owes and changing what every client on a rate list
    /// is charged are different authorities: the first is a day-to-day
    /// commercial view, the second re-prices work for potentially hundreds of
    /// centres at once and belongs with whoever negotiates contracts.
    /// </summary>
    public const string RateManage = "rate:manage";
    public const string AnalyticsView = "analytics:view";
}
