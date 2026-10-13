using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);
if (string.IsNullOrEmpty(builder.Configuration["urls"]))
    builder.WebHost.UseUrls("http://localhost:5085");
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 2048);
builder.Services.AddSingleton<GpsTracker>();
builder.Services.AddSignalR();

var app = builder.Build();
app.Use(async (context, next) =>
{
    context.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    if (context.Request.Path.StartsWithSegments("/api"))
        context.Response.Headers.CacheControl = "no-store";
    try { await next(); }
    catch (BadHttpRequestException error)
    {
        context.Response.StatusCode = error.StatusCode;
        await context.Response.WriteAsJsonAsync(new { error = error.Message });
    }
});
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));
app.MapGet("/api/state", (GpsTracker tracker) => Results.Ok(tracker.Snapshot()));
app.MapPost("/api/route", async (RouteInput input, GpsTracker tracker) =>
    Results.Ok(await tracker.SetRouteAsync(input)));
app.MapPost("/api/location", async (LocationInput input, GpsTracker tracker) =>
    Results.Ok(await tracker.PublishAsync(input)));
app.MapPost("/api/maps/resolve", async (MapsLinkInput input, HttpContext context) =>
    Results.Ok(await GoogleMapsLink.ResolveAsync(input.Url, context.RequestAborted)));
app.MapHub<TrackingHub>("/hubs/tracking");
app.Run();

public sealed class TrackingHub(GpsTracker tracker) : Hub
{
    public GpsState GetState() => tracker.Snapshot();
}
