using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);
if (string.IsNullOrEmpty(builder.Configuration["urls"]))
    builder.WebHost.UseUrls("http://localhost:5085");
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 2048);
builder.Services.AddSingleton<TripTracker>();
builder.Services.AddSignalR(options => options.MaximumReceiveMessageSize = 2048);
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddFixedWindowLimiter("create", limiter =>
    {
        limiter.PermitLimit = 20;
        limiter.Window = TimeSpan.FromMinutes(1);
        limiter.QueueLimit = 0;
    });
});

var app = builder.Build();
app.Use(async (context, next) =>
{
    context.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["X-Frame-Options"] = "DENY";
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
app.UseRateLimiter();
app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));
app.MapPost("/api/trips", (TripTracker tracker) => Results.Ok(tracker.Create()))
    .RequireRateLimiting("create");
app.MapPost("/api/trips/{tripId:guid}/locations", async (
    Guid tripId, LocationInput input, HttpContext context, TripTracker tracker) =>
{
    var authorization = context.Request.Headers.Authorization.ToString();
    var token = authorization.StartsWith("Bearer ", StringComparison.Ordinal) ? authorization[7..] : "";
    return Results.Ok(await tracker.PublishAsync(tripId, token, input));
});
app.MapHub<TrackingHub>("/hubs/tracking");
app.Run();

public sealed class TrackingHub(TripTracker tracker) : Hub
{
    public async Task<LocationPoint?> JoinTrip(Guid tripId, string token)
    {
        try
        {
            tracker.Snapshot(tripId, token);
            if (Context.Items.TryGetValue("trip", out var previous))
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, previous!.ToString()!);
            await Groups.AddToGroupAsync(Context.ConnectionId, tripId.ToString());
            Context.Items["trip"] = tripId;
            // Subscribe before reading: an update cannot fall between snapshot and subscription.
            return tracker.Snapshot(tripId, token);
        }
        catch (BadHttpRequestException error) { throw new HubException(error.Message); }
    }
}
