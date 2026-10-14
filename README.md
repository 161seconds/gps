# Test GPS realtime

Một màn hình chung: chọn điểm đầu, điểm cuối; bật GPS điện thoại; xem vị trí cập nhật trực tiếp trên bản đồ.

## Chạy

Cần .NET 8 trở lên và Node.js 22.

```powershell
npm ci
dotnet run --project GpsDemo.csproj
```

Mở `http://localhost:5085`.

1. Nhấn **Chọn điểm đầu**, bấm vị trí trên bản đồ.
2. Nhấn **Chọn điểm cuối**, bấm vị trí khác. Hai điểm tự đồng bộ sang máy đang xem.
3. Mở cùng URL trên điện thoại và máy tính.
4. Trên điện thoại, nhấn **Bật GPS**, cấp quyền vị trí. Di chuyển để thấy điểm GPS cập nhật trên cả hai màn.
5. Nhấn **Dừng** để ngừng gửi GPS.

Có thể dán link Google Maps vào ô điểm đầu/cuối, nhấn **Dùng link**. Hỗ trợ link địa điểm có tọa độ, link `q`/`query`/`ll`/`center` và link chia sẻ rút gọn `maps.app.goo.gl` / `goo.gl/maps`. Bản đồ tự đưa hai điểm vào khung nhìn. Link chỉ có tên/ID địa điểm hoặc chứa nhiều điểm chỉ đường cần chọn lại một điểm trên Google Maps rồi chia sẻ.

Nút **Chế độ tối / Chế độ sáng** ở đầu trang đổi giao diện, nhớ lựa chọn trên thiết bị. Lần đầu theo giao diện hệ thống; nền bản đồ giữ màu OpenStreetMap.

Bật **Tìm đường ô tô** sau khi chọn hai điểm. Valhalla ưu tiên khoảng cách và tìm tối đa một tuyến phụ trên mạng đường OpenStreetMap, tuân theo đường một chiều và hạn chế ô tô trong dữ liệu bản đồ. Hỗ trợ tuyến dài và xuyên biên giới khi có đường kết nối; không bảo đảm ngắn nhất tuyệt đối. Bấm chọn **Tuyến 1 / Tuyến 2** hoặc bấm đường trên bản đồ: tuyến đang chọn màu hồng, tuyến còn lại màu xanh xám, mỗi tuyến có chiều dài riêng; tuyến ít km hơn trong các kết quả được xếp trước. Có nơi chỉ tìm được một tuyến phù hợp; ứng dụng không tạo tuyến phụ giả. Đổi điểm sẽ tự tìm lại; lỗi hoặc không có đường sẽ xóa tuyến, không thay bằng đường thẳng. Tọa độ được ghép vào đường gần nhất trong phạm vi 200 m; không vẽ đoạn nối giả từ điểm chọn tới đường. Lựa chọn tuyến chỉ áp dụng trong tab hiện tại.

Chấm GPS di chuyển theo vị trí điện thoại thực tế, độc lập với tuyến đường. **Theo vị trí GPS** bật mặc định: bản đồ tự căn giữa theo từng cập nhật; tắt hoặc kéo bản đồ để xem nơi khác, bật lại để quay về GPS. Tuyến tải xong không kéo bản đồ ra khỏi GPS đang cập nhật. Không ép chấm GPS vào tuyến đã chọn hoặc tự tính lại tuyến khi đi lệch.

Định tuyến dùng [dịch vụ công cộng FOSSGIS](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/), gửi tọa độ hai điểm tới dịch vụ, tối đa một yêu cầu/giây mỗi tab. Dịch vụ không đảm bảo hoạt động liên tục; dữ liệu đường có thể thiếu hoặc cũ. `shortest: true` ưu tiên khoảng cách, dùng tìm kiếm phân cấp để hỗ trợ tuyến dài; không yêu cầu tìm kiếm đầy đủ nên không chặn tuyến do cảnh báo `205`. Các lỗi thật như không có đường hoặc vượt giới hạn khoảng cách của máy chủ vẫn báo lỗi. Demo lưu chế độ tìm đường riêng từng tab; dùng máy chủ Valhalla riêng khi cần bảo đảm ngắn nhất tuyệt đối hoặc tải lớn.

Đây là tuyến ô tô tham khảo, chưa xét kích thước/tải trọng xe hàng, quyền vận tải, thủ tục hoặc cửa khẩu được phép. Demo chỉ có A/B; dự án chính cần truyền cửa khẩu bắt buộc thành điểm đi qua và kiểm tra điều kiện vận chuyển riêng.

## Điện thoại cần HTTPS

HTTP qua IP LAN không đủ điều kiện lấy GPS. Có thể chạy tunnel đã có trong workspace:

```powershell
./artifacts/cloudflared.exe tunnel --no-autoupdate --url http://localhost:5085 --protocol http2
```

Mở URL HTTPS do tunnel trả về trên cả điện thoại và máy tính. Giữ server/tunnel chạy; giữ trang GPS mở. Trình duyệt có thể ngừng GPS khi vào nền hoặc khóa màn hình.

## Kiểm tra

```powershell
npm run check
```

Self-check kiểm tra giao diện bằng Node, hai tuyến với phản hồi mẫu (chọn tuyến, geometry, lỗi, hủy tuyến cũ), theo GPS, hai kết nối SignalR thật: điểm đầu/cuối, GPS phát đến cả hai màn, validation, bỏ điểm GPS cũ, snapshot khi kết nối lại. Server phải đang chạy. Có thể đổi URL bằng biến môi trường `GPS_URL`.

## Giới hạn

- Một phiên dùng chung, không tài khoản/token/tạo chuyến/hết hạn. Ai có URL đều xem và gửi vị trí; chỉ bật GPS trên một điện thoại mỗi lần test.
- Chỉ giữ hai mốc và điểm GPS cuối trong RAM. Restart xóa dữ liệu; cùng URL vẫn dùng được.
- Không có mô phỏng GPS, lưu lịch sử, tìm địa chỉ, chỉ dẫn rẽ từng bước hoặc nghiệp vụ Pegaxus.
- Bản đồ dùng OpenStreetMap với attribution và `strict-origin-when-cross-origin` để gửi Referer hợp lệ. Không proxy hoặc tải tile hàng loạt.
- Tunnel chuyển dữ liệu qua Cloudflare. Chưa thay thế cơ chế xác thực/lưu trữ của dự án chính.
