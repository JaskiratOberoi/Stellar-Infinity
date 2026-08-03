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
}

app.UseExceptionHandler();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.MapInfinityEndpoints();
app.MapAuthEndpoints();
app.MapAdminEndpoints();

app.Run();
