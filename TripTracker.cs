using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR;

public sealed class TripTracker(IHubContext<TrackingHub> hub)
{
    private readonly Dictionary<Guid, Trip> trips = [];
    private readonly object gate = new();

    public object Create()
    {
        lock (gate)
        {
            foreach (var expiredId in trips.Where(pair => pair.Value.ExpiresAt <= DateTimeOffset.UtcNow).Select(pair => pair.Key).ToArray())
                trips.Remove(expiredId);
            if (trips.Count >= 100)
                throw new BadHttpRequestException("Demo session limit reached. Restart the demo or wait for expiry.", 429);
            var id = Guid.NewGuid();
            var trip = new Trip();
            trips.Add(id, trip);
            return new { tripId = id, driverToken = trip.DriverToken, viewerToken = trip.ViewerToken, trip.ExpiresAt };
        }
    }

    public LocationPoint? Snapshot(Guid id, string? token)
    {
        lock (gate)
        {
            var trip = Find(id);
            if (!Matches(token, trip.ViewerToken) && !Matches(token, trip.DriverToken))
                throw new BadHttpRequestException("Invalid viewing key.", 403);
            return trip.Latest;
        }
    }

    public async Task<LocationPoint> PublishAsync(Guid id, string? token, LocationInput input)
    {
        LocationPoint point;
        lock (gate)
        {
            var trip = Find(id);
            if (!Matches(token, trip.DriverToken))
                throw new BadHttpRequestException("A driver key for this trip is required.", 403);
            var now = DateTimeOffset.UtcNow;
            if (!double.IsFinite(input.Latitude) || input.Latitude is < -90 or > 90 ||
                !double.IsFinite(input.Longitude) || input.Longitude is < -180 or > 180 ||
                !double.IsFinite(input.Accuracy) || input.Accuracy < 0 ||
                input.Source is not ("gps" or "simulation"))
                throw new BadHttpRequestException("Invalid coordinates, accuracy or source.", 400);
            if (input.CapturedAt < now.AddMinutes(-10) || input.CapturedAt > now.AddSeconds(30))
                throw new BadHttpRequestException("GPS timestamp must be within the last 10 minutes and no more than 30 seconds ahead.", 400);
            if (trip.Latest is { } latest && input.CapturedAt <= latest.CapturedAt)
                throw new BadHttpRequestException("An older or duplicate GPS point cannot replace the latest point.", 409);
            if (trip.Latest is { } recent && now - recent.ReceivedAt < TimeSpan.FromMilliseconds(250))
                throw new BadHttpRequestException("Send at most four GPS updates per second.", 429);
            point = new(id, input.Latitude, input.Longitude, input.Accuracy, input.CapturedAt,
                now, (trip.Latest?.Sequence ?? 0) + 1, input.Source);
            trip.Latest = point;
        }
        // Clients compare Sequence: concurrent broadcasts and reconnect snapshots can arrive out of order.
        await hub.Clients.Group(id.ToString()).SendAsync("LocationUpdated", point);
        return point;
    }

    private Trip Find(Guid id)
    {
        if (!trips.TryGetValue(id, out var trip) || trip.ExpiresAt <= DateTimeOffset.UtcNow)
            throw new BadHttpRequestException("Trip is missing or expired. Create a new test trip.", 404);
        return trip;
    }

    private static bool Matches(string? actual, string expected) =>
        actual?.Length == expected.Length && CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(actual), Encoding.UTF8.GetBytes(expected));

    // shortcut: 1-hour trips and their latest point live in memory; replace with Pegaxus auth/storage during integration.
    private sealed class Trip
    {
        public string DriverToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        public string ViewerToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        public DateTimeOffset ExpiresAt { get; } = DateTimeOffset.UtcNow.AddHours(1);
        public LocationPoint? Latest { get; set; }
    }
}

public sealed record LocationInput
{
    public required double Latitude { get; init; }
    public required double Longitude { get; init; }
    public required double Accuracy { get; init; }
    public required DateTimeOffset CapturedAt { get; init; }
    public required string Source { get; init; }
}

public sealed record LocationPoint(Guid TripId, double Latitude, double Longitude, double Accuracy,
    DateTimeOffset CapturedAt, DateTimeOffset ReceivedAt, long Sequence, string Source);
