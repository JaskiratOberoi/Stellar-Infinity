using Infinity.Api.Admin;
using Infinity.Api.Auth;
using Infinity.Api.Data;
using Infinity.Api.Endpoints;
using Infinity.Api.Reads;
using Microsoft.AspNetCore.Authentication.JwtBearer;

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
builder.Services.AddSingleton<OrdersRepository>();
builder.Services.AddSingleton<ReportsRepository>();
// Singletons: the knowledge base is parsed once at startup, not per request.
builder.Services.AddSingleton<Infinity.Api.Reports.SmartMeta>();
builder.Services.AddSingleton<Infinity.Api.Reports.SmartReportService>();
builder.Services.AddSingleton<ScopeRepository>();
builder.Services.AddSingleton<Infinity.Api.Audit.AuditRepository>();

// ---- worksheet -----------------------------------------------------------
builder.Services.AddSingleton<Infinity.Api.Worksheet.WorksheetRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.ResultWriteRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.AutoAuthRepository>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.AutoAuthGate>();
builder.Services.AddSingleton<Infinity.Api.Worksheet.ResultHistoryRepository>();

// ---- instruments ---------------------------------------------------------
builder.Services.AddSingleton<Infinity.Api.Instruments.InstrumentRepository>();
builder.Services.AddSingleton<Infinity.Api.Instruments.InstrumentAuthenticator>();

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
        options.Events = SessionVersionValidator.Create();
    });

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
}

// Must run before anything that reads the client IP.
app.UseForwardedHeaders();

app.UseExceptionHandler();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.MapInfinityEndpoints();
app.MapAuthEndpoints();
app.MapAdminEndpoints();
app.MapWorksheetEndpoints();
app.MapInstrumentEndpoints();

app.Run();
