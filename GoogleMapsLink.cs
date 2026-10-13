using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.WebUtilities;

public sealed record MapsLinkInput
{
    public required string Url { get; init; }
}

public static class GoogleMapsLink
{
    private static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false })
    { Timeout = TimeSpan.FromSeconds(10) };
    private const string Number = @"[-+]?(?:\d+(?:\.\d*)?|\.\d+)";

    public static async Task<GeoPoint> ResolveAsync(string? value, CancellationToken cancellationToken)
    {
        var uri = ValidateUrl(value);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            for (var redirects = 0; redirects <= 5; redirects++)
            {
                if (uri.Host is not ("maps.app.goo.gl" or "goo.gl")) return Parse(uri);
                if (redirects == 5) throw new BadHttpRequestException("Link Google Maps chuyển hướng quá nhiều lần.", 502);
                using var response = await Client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if ((int)response.StatusCode is not (301 or 302 or 303 or 307 or 308) || response.Headers.Location is null)
                    throw new BadHttpRequestException("Không mở được link Google Maps rút gọn. Hãy dán link đầy đủ có tọa độ.", 502);
                uri = ValidateUrl(new Uri(uri, response.Headers.Location).AbsoluteUri);
            }
        }
        catch (HttpRequestException) { throw new BadHttpRequestException("Không kết nối được Google Maps. Hãy thử lại hoặc dán link đầy đủ.", 502); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new BadHttpRequestException("Google Maps phản hồi quá lâu. Hãy thử lại hoặc dán link đầy đủ.", 502); }
        throw Unsupported();
    }

    private static Uri ValidateUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 2000 || !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ||
            uri.Scheme != "https" || uri.Port != 443 || uri.UserInfo.Length != 0 ||
            uri.Host is not ("maps.app.goo.gl" or "goo.gl" or "google.com" or "www.google.com" or "maps.google.com" or "google.com.vn" or "www.google.com.vn" or "maps.google.com.vn") ||
            (uri.Host == "goo.gl" && !uri.AbsolutePath.StartsWith("/maps/", StringComparison.OrdinalIgnoreCase)) ||
            (uri.Host is "google.com" or "www.google.com" or "google.com.vn" or "www.google.com.vn" &&
             !(uri.AbsolutePath == "/maps" || uri.AbsolutePath.StartsWith("/maps/", StringComparison.OrdinalIgnoreCase))))
            throw new BadHttpRequestException("Chỉ nhận link HTTPS Google Maps hợp lệ.", 400);
        return uri;
    }

    private static GeoPoint Parse(Uri uri)
    {
        var path = Uri.UnescapeDataString(uri.AbsolutePath);
        if (path.Contains("/dir/", StringComparison.OrdinalIgnoreCase)) throw Unsupported();
        var decoded = path + Uri.UnescapeDataString(uri.Query);
        var places = Regex.Matches(decoded, $@"!3d({Number})!4d({Number})(?=!|/|[?&]|$)");
        if (places.Count == 1) return Point(places[0].Groups[1].Value, places[0].Groups[2].Value);
        if (places.Count > 1) throw Unsupported();
        var query = QueryHelpers.ParseQuery(uri.Query);
        if (query.ContainsKey("cid") || query.ContainsKey("query_place_id") || query.ContainsKey("ftid")) throw Unsupported();
        foreach (var key in new[] { "q", "query", "ll", "center" })
            if (query.TryGetValue(key, out var value))
            {
                var pair = Regex.Match(value.ToString(), $@"^\s*({Number})\s*,\s*({Number})\s*$");
                if (pair.Success) return Point(pair.Groups[1].Value, pair.Groups[2].Value);
                throw Unsupported();
            }
        // shortcut: no place-name lookup; ask for coordinates when the link only identifies a place.
        if (path.Contains("/place/", StringComparison.OrdinalIgnoreCase) || decoded.Contains("!1s", StringComparison.Ordinal)) throw Unsupported();
        var center = Regex.Match(path, $@"@({Number}),({Number})(?=,|/|$)");
        if (center.Success) return Point(center.Groups[1].Value, center.Groups[2].Value);
        throw Unsupported();
    }

    private static GeoPoint Point(string latitude, string longitude)
    {
        if (!double.TryParse(latitude, NumberStyles.Float, CultureInfo.InvariantCulture, out var lat) ||
            !double.TryParse(longitude, NumberStyles.Float, CultureInfo.InvariantCulture, out var lng) ||
            !double.IsFinite(lat) || lat is < -90 or > 90 || !double.IsFinite(lng) || lng is < -180 or > 180)
            throw new BadHttpRequestException("Tọa độ trong link Google Maps không hợp lệ.", 400);
        return new GeoPoint { Latitude = lat, Longitude = lng };
    }

    private static BadHttpRequestException Unsupported() => new(
        "Link chưa có tọa độ rõ ràng. Trong Google Maps, chọn một điểm rồi sao chép link có tọa độ; hoặc chọn điểm trên bản đồ.", 400);
}
