using Infinity.Api.Admin;
using Infinity.Api.Auth;
using Infinity.Api.Data;
using Infinity.Api.Endpoints;
using Infinity.Api.Reads;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Options;

// CreateSlimBuilder: minimal-API-tuned host with the IIS/EventLog/EventSource
// plumbing left out. Same request throughput, leaner startup and image.
var builder = WebApplication.CreateSlimBuilder(args);

// ---- configuration -------------------------------------------------------
// Env vars use the double-underscore form: Noble__Server, Jwt__Secret, ...
builder.Services
    .AddOptions<NobleOptions>()
    .Bind(builder.Configuration.GetSection(NobleOptions.SectionName))
    .Validate(o => o.Validate().Count == 0, "Noble connection settings are incomplete — see Noble__* environment variables.")
    // Fail at startup, not on the first request that happens to need the DB.
    .ValidateOnStart();

builder.Services
    .AddOptions<JwtOptions>()
    .Bind(builder.Configuration.GetSection(JwtOptions.SectionName))
    .Validate(o => o.Validate().Count == 0, "JWT settings are incomplete — set Jwt__Secret to at least 32 bytes.")
    .ValidateOnStart();

// ---- data layer ----------------------------------------------------------
// Singletons: the factory caches the connection string (the pool key), and the
// retry helper is stateless. Repositories are cheap and stateless too.
builder.Services.AddSingleton<NobleConnectionFactory>();
builder.Services.AddSingleton<SqlRetry>();
builder.Services.AddSingleton<SampleHeaderRepository>();
builder.Services.AddSingleton<StatsRepository>();
builder.Services.AddSingleton<MonthStatsRepository>();
builder.Services.AddSingleton<OrdersRepository>();
builder.Services.AddSingleton<ReportsRepository>();
builder.Services.AddSingleton<CatalogRepository>();
builder.Services.AddSingleton<Infinity.Api.Orders.CartStore>();
builder.Services.AddSingleton<Infinity.Api.Orders.OrderWriteRepository>();
builder.Services.AddSingleton<Infinity.Api.Orders.OrderDraftRepository>();
builder.Services.AddSingleton<Infinity.Api.Orders.CustomTestRepository>();
builder.Services.AddSingleton<Infinity.Api.Orders.AccessionRepository>();
builder.Services.AddSingleton<Infinity.Api.Reports.ReportExtrasRepository>();
builder.Services.AddSingleton<Infinity.Api.Reports.CatalogueDetailRepository>();
builder.Services.AddSingleton<Infinity.Api.Reports.SmartReportAccessRepository>();
builder.Services.AddSingleton<Infinity.Api.Reports.ReportLink>();
builder.Services.AddSingleton<Infinity.Api.Orders.ClientAccountRepository>();
builder.Services.AddSingleton<Infinity.Api.Orders.SalesRepository>();
builder.Services.AddSingleton<Infinity.Api.Payments.PaymentRepository>();
// Signs the public receipt link. Shares Reports:TokenSecret with the report
// QR links, under a different purpose prefix - see PaymentReceiptLink.
builder.Services.AddSingleton<Infinity.Api.Payments.PaymentReceiptLink>();

// CCAvenue. Validated at STARTUP so a half-set deployment fails the deploy
// rather than the first customer who tries to pay. Being entirely unset is
// legitimate and means the pay button is not offered at all.
builder.Services
    .AddOptions<Infinity.Api.Payments.CCAvenueOptions>()
    .Bind(builder.Configuration.GetSection(Infinity.Api.Payments.CCAvenueOptions.SectionName))
    .Validate(o => o.Validate().Count == 0,
        "CCAvenue settings are incomplete - see CCAvenue__* environment variables.")
    .ValidateOnStart();
builder.Services.AddSingleton<Infinity.Api.Orders.BillingRepository>();
builder.Services.AddSingleton<Infinity.Api.Orders.RateListRepository>();
builder.Services.AddSingleton<Infinity.Api.Orders.InvoiceRepository>();
// Singletons: the knowledge base is parsed once at startup, not per request.
builder.Services.AddSingleton<Infinity.Api.Reports.SmartMeta>();
builder.Services.AddSingleton<Infinity.Api.Reports.SmartReportService>();
builder.Services.AddSingleton<Infinity.Api.Orders.ReferrerRepository>();
builder.Services.AddSingleton<Infinity.Api.Reports.GraphRepository>();
builder.Services.AddSingleton<Infinity.Api.Reports.ReportLockRepository>();

// The render sidecar. A typed client rather than a bare HttpClient so the base
// address and the generous timeout live in one place: a merged batch of fifty
// reports legitimately runs for minutes, and the default 100s would cut it off
// mid-document.
builder.Services.AddHttpClient<Infinity.Api.Reports.RenderClient>(c =>
{
    c.BaseAddress = new Uri(builder.Configuration["Render:BaseUrl"] ?? "http://render:8090");
    c.Timeout = TimeSpan.FromMinutes(10);
});

builder.Services.AddSingleton<ScopeRepository>();
builder.Services.AddSingleton<Infinity.Api.Audit.AuditRepository>();
builder.Services.AddSingleton<Infinity.Api.Audit.AuditLog>();
builder.Services.AddSingleton<Infinity.Api.Audit.AuditTrailRepository>();

// ---- worksheet -----------------------------------------------------------
builder.Services.AddSingleton<Infinity.Api.Worksheet.WorksheetRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.ResultWriteRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.PatientEditRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.AutoAuthRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.AutoAuthGate>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.AttachmentRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.ResultHistoryRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.InwardRepository>();

// ---- instruments ---------------------------------------------------------
builder.Services.AddSingleton<Infinity.Api.Instruments.InstrumentRepository>();
builder.Services.AddSingleton<Infinity.Api.Instruments.InstrumentAuthenticator>();

// ---- interfacing (remote lab sites running Stellar Synapse) --------------
builder.Services.AddSingleton<Infinity.Api.Interfacing.SiteAuthenticator>();
builder.Services.AddSingleton<Infinity.Api.Interfacing.InterfacingRepository>();

// Auto-authorization unlock secret. Validated at STARTUP rather than on first
// use: a malformed hash makes the gate fail closed, and an operator would
// otherwise discover that only when they tried to change a setting and were
// told, unhelpfully, that their password was wrong.
builder.Services
    .AddOptions<Infinity.Api.Worksheet.AutoAuthOptions>()
    .Bind(builder.Configuration.GetSection(Infinity.Api.Worksheet.AutoAuthOptions.SectionName))
    .Validate(o => o.Validate().Count == 0,
        "AutoAuth settings are invalid — AutoAuth__UnlockHash must be a pbkdf2-sha256 digest.")
    .ValidateOnStart();

// Trust the forwarded headers from our own reverse proxy, and ONLY it.
//
// The API is deliberately not published: the sole peer that can reach it is the
// SPA's nginx on the compose network, so the immediate connection is always the
// proxy and its X-Forwarded-For is ours. If the API is ever exposed directly,
// this becomes forgeable and must be tightened to explicit KnownProxies —
// getting it wrong means an attacker chooses what the audit trail records as
// their IP, which is precisely the legacy defect being fixed here.
builder.Services.Configure<Microsoft.AspNetCore.Builder.ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor
                       | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto;
    o.ForwardLimit = 1;
    o.KnownNetworks.Clear();
    o.KnownProxies.Clear();
});
// ---- shared cache --------------------------------------------------------
// Redis when configured, in-process when not. RequireDistributed turns the
// multi-instance mistake into a startup failure rather than a silent one.
builder.Services
    .AddOptions<Infinity.Api.Caching.CacheOptions>()
    .Bind(builder.Configuration.GetSection(Infinity.Api.Caching.CacheOptions.SectionName))
    .Validate(o => o.Validate().Count == 0,
        "Cache settings are invalid — see Cache__* environment variables.")
    .ValidateOnStart();

builder.Services.AddSingleton<Infinity.Api.Caching.InfinityCache>();
builder.Services.AddSingleton<Infinity.Api.Caching.DistributedRateLimiter>();

builder.Services.AddSingleton<AuthRepository>();
builder.Services.AddSingleton<AdminRepository>();
builder.Services.AddSingleton<JwtIssuer>();
builder.Services.AddMemoryCache();

// ---- auth ----------------------------------------------------------------
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer();

// Configured through the options system rather than inline in AddJwtBearer, so
// JwtIssuer is resolved from the real container. Calling BuildServiceProvider()
// inside the callback would spin up a SECOND container and a second JwtIssuer —
// validation and minting could then disagree about the signing key.
builder.Services
    .AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
    .Configure<JwtIssuer>((options, issuer) =>
    {
        options.TokenValidationParameters = issuer.ValidationParameters;
        options.MapInboundClaims = false;   // keep 'sub'/'cap' as written, unmapped

        var events = SessionVersionValidator.Create();

        // Take the token from the httpOnly cookie when no Authorization header
        // is present. The header still works — instrument drivers, scripts and
        // curl are unaffected — but the SPA no longer holds a token it could
        // leak through XSS.
        var cookieName = builder.Configuration[$"{AuthCookieOptions.SectionName}:TokenCookieName"] ?? "inf_session";
        var inner = events.OnMessageReceived;
        events.OnMessageReceived = async ctx =>
        {
            if (string.IsNullOrEmpty(ctx.Token)
                && string.IsNullOrEmpty(ctx.Request.Headers.Authorization.ToString())
                && ctx.Request.Cookies.TryGetValue(cookieName, out var fromCookie)
                && !string.IsNullOrEmpty(fromCookie))
            {
                ctx.Token = fromCookie;
            }

            if (inner is not null) await inner(ctx);
        };

        options.Events = events;
    });

// Session cookie settings. Secure defaults to true; the compose stack serves
// plain HTTP on a loopback port, where a Secure cookie is silently dropped, so
// it is overridable — with a loud warning at startup when it is off.
builder.Services
    .AddOptions<AuthCookieOptions>()
    .Bind(builder.Configuration.GetSection(AuthCookieOptions.SectionName));

builder.Services.AddAuthorization();
builder.Services.AddInfinityRateLimiting();
builder.Services.AddProblemDetails();

var app = builder.Build();

// Resolve the Smart Report knowledge base eagerly. AddSingleton is lazy, so a
// missing or malformed embedded smart-meta.json would otherwise surface as a
// 500 on the first patient report rather than a failed deploy.
{
    var smartMeta = app.Services.GetRequiredService<Infinity.Api.Reports.SmartMeta>();
    app.Logger.LogInformation("smartmeta.loaded categories={Categories}", smartMeta.Categories.Count);

    // Connect the cache at startup so its mode is stated once in the log,
    // rather than being inferred later from whether limits behave oddly.
    var cache = app.Services.GetRequiredService<Infinity.Api.Caching.InfinityCache>();
    app.Logger.LogInformation("cache.mode distributed={Distributed}", cache.IsDistributed);

    // An insecure session cookie is a deployment mistake that is invisible in
    // normal use, so it is stated at every startup rather than left to be
    // discovered.
    var cookies = app.Services.GetRequiredService<IOptions<AuthCookieOptions>>().Value;
    if (!cookies.Secure)
    {
        app.Logger.LogWarning(
            "authcookie.insecure — the session cookie is being issued WITHOUT the Secure attribute. "
          + "This is only acceptable behind plain HTTP on a trusted loopback. Set AuthCookie__Secure=true "
          + "as soon as TLS terminates in front of this API.");
    }
    app.Logger.LogInformation("authcookie.mode secure={Secure} sameSite={SameSite}", cookies.Secure, cookies.SameSite);

    // Which gateway, and whether one is connected at all. Stated once at
    // startup because "is this stack taking real money?" must not be a
    // question anyone answers by trying it.
    var ccav = app.Services.GetRequiredService<IOptions<Infinity.Api.Payments.CCAvenueOptions>>().Value;
    app.Logger.LogInformation(
        "ccavenue.mode enabled={Enabled} test={Test} redirect={Redirect}",
        ccav.Enabled,
        ccav.GatewayUrl.Contains("test.ccavenue.com", StringComparison.OrdinalIgnoreCase),
        ccav.Enabled ? ccav.RedirectUrl : "(none)");
}

// Must run before anything that reads the client IP.
app.UseForwardedHeaders();

app.UseExceptionHandler();
app.UseRateLimiter();

// Before authentication: a forged cross-site write must be refused on the way
// in, not after its identity has been established.
app.UseInfinityCsrfProtection();

app.UseAuthentication();
app.UseAuthorization();

app.MapInfinityEndpoints();
app.MapAuthEndpoints();
app.MapAdminEndpoints();
app.MapWorksheetEndpoints();
app.MapInstrumentEndpoints();
app.MapInterfacingEndpoints();
app.MapUpdateEndpoints();
app.MapOrderEntryEndpoints();
app.MapAuditEndpoints();
app.MapAccessionEndpoints();
app.MapInwardEndpoints();
app.MapClientAccountEndpoints();
app.MapPaymentEndpoints();
app.MapBillingEndpoints();
app.MapRateListEndpoints();
app.MapInvoiceEndpoints();
app.MapReportPdfEndpoints();
app.MapPublicReportEndpoints();

app.Run();
