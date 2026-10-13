using Microsoft.AspNetCore.SignalR;

public sealed class GpsTracker(IHubContext<TrackingHub> hub)
{
    private readonly object gate = new();
    private GeoPoint? start, end;
    private LocationPoint? latest;
    private long routeSequence;

    public GpsState Snapshot()
    {
        lock (gate) return new(start, end, latest, routeSequence);
    }

    public async Task<RouteState> SetRouteAsync(RouteInput input)
    {
        if (input.Start is null || input.End is null)
            throw new BadHttpRequestException("Choose both start and end points.", 400);
        ValidateCoordinates(input.Start.Latitude, input.Start.Longitude);
        ValidateCoordinates(input.End.Latitude, input.End.Longitude);
        RouteState route;
        lock (gate)
        {
            start = input.Start;
            end = input.End;
            route = new(start, end, ++routeSequence);
        }
        await hub.Clients.All.SendAsync("RouteUpdated", route);
        return route;
    }

    public async Task<LocationPoint> PublishAsync(LocationInput input)
    {
        ValidateCoordinates(input.Latitude, input.Longitude);
        if (!double.IsFinite(input.Accuracy) || input.Accuracy < 0)
            throw new BadHttpRequestException("GPS accuracy must be a finite, non-negative number.", 400);
        LocationPoint point;
        lock (gate)
        {
            var now = DateTimeOffset.UtcNow;
            if (input.CapturedAt < now.AddMinutes(-10) || input.CapturedAt > now.AddSeconds(30))
                throw new BadHttpRequestException("GPS timestamp is too old or ahead of the server clock.", 400);
            if (latest is not null && input.CapturedAt <= latest.CapturedAt)
                throw new BadHttpRequestException("Older or duplicate GPS point ignored.", 409);
            point = new(input.Latitude, input.Longitude, input.Accuracy, input.CapturedAt,
                now, (latest?.Sequence ?? 0) + 1);
            latest = point;
        }
        await hub.Clients.All.SendAsync("LocationUpdated", point);
        return point;
    }

    private static void ValidateCoordinates(double latitude, double longitude)
    {
        if (!double.IsFinite(latitude) || latitude is < -90 or > 90 ||
            !double.IsFinite(longitude) || longitude is < -180 or > 180)
            throw new BadHttpRequestException("Coordinates are invalid.", 400);
    }
}

// shortcut: one shared GPS test in RAM; add separate sessions only when testing multiple phones independently.
public sealed record GpsState(GeoPoint? Start, GeoPoint? End, LocationPoint? Location, long RouteSequence);
public sealed record RouteState(GeoPoint Start, GeoPoint End, long Sequence);
public sealed record GeoPoint
{
    public required double Latitude { get; init; }
    public required double Longitude { get; init; }
}
public sealed record RouteInput
{
    public required GeoPoint Start { get; init; }
    public required GeoPoint End { get; init; }
}
public sealed record LocationInput
{
    public required double Latitude { get; init; }
    public required double Longitude { get; init; }
    public required double Accuracy { get; init; }
    public required DateTimeOffset CapturedAt { get; init; }
}
public sealed record LocationPoint(double Latitude, double Longitude, double Accuracy,
    DateTimeOffset CapturedAt, DateTimeOffset ReceivedAt, long Sequence);
