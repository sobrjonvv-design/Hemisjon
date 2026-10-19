param(
    [int]$Port = 8080,
    [string[]]$AdditionalAllowedHosts = @()
)
# Loopback-only, buildless web server and narrowly scoped HEMIS bridge.
# No passwords, bearer tokens or request bodies are written to disk/logs.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$rootPath = [IO.Path]::GetFullPath($PSScriptRoot)
$allowedHosts = @('student.tift.uz','xmn.tuit.uz','student.tdtu.uz','talaba.tsue.uz','hstudent.nuu.uz','student.hemis.uz') + $AdditionalAllowedHosts
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$handler.UseCookies = $false
$httpClient = New-Object System.Net.Http.HttpClient($handler)
$httpClient.Timeout = [TimeSpan]::FromSeconds(22)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
$utf8 = New-Object Text.UTF8Encoding($false)
$mime = @{'.html'='text/html; charset=utf-8';'.css'='text/css; charset=utf-8';'.js'='text/javascript; charset=utf-8';'.json'='application/json; charset=utf-8';'.svg'='image/svg+xml';'.png'='image/png';'.md'='text/plain; charset=utf-8'}

function Send-Response($stream, [int]$status, [byte[]]$bytes, [string]$contentType, [string]$origin) {
    $reason = @{200='OK';204='No Content';400='Bad Request';403='Forbidden';404='Not Found';405='Method Not Allowed';413='Payload Too Large';431='Request Header Fields Too Large';502='Bad Gateway';504='Gateway Timeout'}[$status]
    if (!$reason) { $reason = 'Response' }
    $head = "HTTP/1.1 $status $reason`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`n"
    if ($origin) { $head += "Access-Control-Allow-Origin: $origin`r`nVary: Origin`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type, Authorization`r`nAccess-Control-Allow-Private-Network: true`r`n" }
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($head + "`r`n")
    $stream.Write($headerBytes,0,$headerBytes.Length)
    if ($bytes.Length) { $stream.Write($bytes,0,$bytes.Length) }
    $stream.Flush()
}
function Send-Json($stream,[int]$status,$value,[string]$origin) {
    $encoded = $utf8.GetBytes(($value | ConvertTo-Json -Depth 64 -Compress))
    Send-Response $stream $status $encoded 'application/json; charset=utf-8' $origin
}
function Test-PublicAddress([Net.IPAddress]$address) {
    if ([Net.IPAddress]::IsLoopback($address)) { return $false }
    if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) {
        if ($address.IsIPv4MappedToIPv6) { return Test-PublicAddress $address.MapToIPv4() }
        $bytes = $address.GetAddressBytes()
        return !($address.IsIPv6LinkLocal -or $address.IsIPv6SiteLocal -or (($bytes[0] -band 254) -eq 252) -or $address.Equals([Net.IPAddress]::IPv6Any))
    }
    $b = $address.GetAddressBytes()
    return !($b[0] -in @(0,10,127,169,224,240,255) -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or ($b[0] -eq 192 -and $b[1] -eq 168) -or ($b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127))
}

try {
    $listener.Start()
    Write-Output "HEMIS Planner: http://127.0.0.1:$Port/ (Ctrl+C to stop)"
    $waitingClients = New-Object System.Collections.ArrayList
    while ($true) {
        while ($listener.Pending()) { [void]$waitingClients.Add(@{Socket=$listener.AcceptTcpClient();Created=[DateTime]::UtcNow}) }
        $ready = $null
        foreach ($entry in @($waitingClients.ToArray())) {
            if ($entry.Socket.Available -gt 0 -and !$ready) { $ready=$entry }
            elseif (([DateTime]::UtcNow - $entry.Created).TotalSeconds -gt 15) { $entry.Socket.Dispose(); $waitingClients.Remove($entry) }
        }
        if (!$ready) { Start-Sleep -Milliseconds 15; continue }
        $waitingClients.Remove($ready)
        $client = $ready.Socket
        $stream = $null
        try {
            $client.ReceiveTimeout = 10000; $client.SendTimeout = 10000
            $stream = $client.GetStream()
            $headerBuffer = New-Object IO.MemoryStream
            $last = ''
            while ($last -ne "`r`n`r`n") {
                $item = $stream.ReadByte()
                if ($item -lt 0) { throw 'Incomplete HTTP request' }
                $headerBuffer.WriteByte([byte]$item)
                if ($headerBuffer.Length -gt 32768) { throw 'HTTP headers too large' }
                $last = ($last + [char]$item)
                if ($last.Length -gt 4) { $last = $last.Substring($last.Length-4) }
            }
            $lines = [Text.Encoding]::ASCII.GetString($headerBuffer.ToArray()).Split(@("`r`n"),[StringSplitOptions]::None)
            $request = $lines[0].Split(' ')
            $method = $request[0]; $requestPath = $request[1]
            $headers = @{}
            foreach ($line in $lines | Select-Object -Skip 1) { $colon=$line.IndexOf(':'); if ($colon -gt 0) { $headers[$line.Substring(0,$colon).ToLowerInvariant()]=$line.Substring($colon+1).Trim() } }
            $origin = ''
            if ($headers.ContainsKey('origin')) {
                $parsedOrigin = $null
                if (![Uri]::TryCreate($headers['origin'],[UriKind]::Absolute,[ref]$parsedOrigin) -or $parsedOrigin.Scheme -notin @('http','https') -or $parsedOrigin.UserInfo) { Send-Json $stream 403 @{ok=$false;error='HTTP(S) origin required'} ''; continue }
                $origin = $parsedOrigin.GetLeftPart([UriPartial]::Authority)
            }
            if ($headers.ContainsKey('transfer-encoding')) { Send-Json $stream 400 @{ok=$false;error='Use Content-Length'} $origin; continue }
            $length = 0
            if ($headers.ContainsKey('content-length') -and ![int]::TryParse($headers['content-length'],[ref]$length)) { Send-Json $stream 400 @{ok=$false;error='Invalid Content-Length'} $origin; continue }
            if ($length -lt 0 -or $length -gt 2097152) { Send-Json $stream 413 @{ok=$false;error='Request too large'} $origin; continue }
            $body = New-Object byte[] $length
            $offset = 0
            while ($offset -lt $length) { $read=$stream.Read($body,$offset,$length-$offset); if ($read -le 0) { throw 'Incomplete request body' }; $offset += $read }
            if ($method -eq 'OPTIONS') { Send-Response $stream 204 ([byte[]]@()) 'text/plain' $origin; continue }
            $path = [Uri]::UnescapeDataString(($requestPath -split '\?')[0])
            if ($path -eq '/hemis-proxy') {
                if ($method -ne 'POST') { Send-Json $stream 405 @{ok=$false;error='POST required'} $origin; continue }
                $payload = $utf8.GetString($body) | ConvertFrom-Json
                $target = $null
                if (![Uri]::TryCreate([string]$payload.target,[UriKind]::Absolute,[ref]$target) -or $target.Scheme -ne 'https' -or !$target.IsDefaultPort -or $target.UserInfo -or $target.Fragment -or $target.DnsSafeHost -notin $allowedHosts) {
                    Send-Json $stream 403 @{ok=$false;status=403;error='Portal not allowed. Add your portal using -AdditionalAllowedHosts when starting server.ps1.'} $origin; continue
                }
                if ($target.AbsolutePath -notmatch '^/rest/v1/(auth/login|education/(schedule|attendance|subjects))$' -or ($target.Query -and $target.Query -notmatch '^\?page=\d{1,4}$')) { Send-Json $stream 403 @{ok=$false;status=403;error='Endpoint not allowed'} $origin; continue }
                $verb = ([string]$payload.method).ToUpperInvariant()
                if (($target.AbsolutePath -eq '/rest/v1/auth/login' -and $verb -ne 'POST') -or ($target.AbsolutePath -ne '/rest/v1/auth/login' -and $verb -ne 'GET')) { Send-Json $stream 405 @{ok=$false;status=405;error='Method not allowed'} $origin; continue }
                $addresses = [Net.Dns]::GetHostAddresses($target.DnsSafeHost)
                if (!$addresses.Count -or @($addresses | Where-Object { !(Test-PublicAddress $_) }).Count) { Send-Json $stream 403 @{ok=$false;status=403;error='Private network destinations are blocked'} $origin; continue }
                $message = New-Object Net.Http.HttpRequestMessage((New-Object Net.Http.HttpMethod($verb)), $target)
                try {
                    $message.Headers.Accept.ParseAdd('application/json')
                    if ($payload.token) { $message.Headers.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer',([string]$payload.token -replace '^Bearer\s+','')) }
                    if ($verb -eq 'POST') { $message.Content = New-Object Net.Http.StringContent(($payload.body | ConvertTo-Json -Depth 10 -Compress),$utf8,'application/json') }
                    $upstream = $httpClient.SendAsync($message).GetAwaiter().GetResult()
                    try {
                        if ($upstream.Content.Headers.ContentLength -gt 10485760) { throw 'Response too large' }
                        $raw = $upstream.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                        if ($raw.Length -gt 10485760) { throw 'Response too large' }
                        try { $data=$raw | ConvertFrom-Json } catch { Send-Json $stream 502 @{ok=$false;status=[int]$upstream.StatusCode;error='Portal returned a non-JSON response'} $origin; continue }
                        Send-Json $stream 200 @{ok=[bool]$upstream.IsSuccessStatusCode;status=[int]$upstream.StatusCode;data=$data} $origin
                    } finally { $upstream.Dispose() }
                } finally { $message.Dispose() }
                continue
            }
            if ($method -notin @('GET','HEAD')) { Send-Json $stream 405 @{ok=$false;error='GET required'} $origin; continue }
            if ($path -eq '/') { $path='/index.html' }
            $candidate = [IO.Path]::GetFullPath((Join-Path $rootPath $path.TrimStart('/').Replace('/',[IO.Path]::DirectorySeparatorChar)))
            $extension = [IO.Path]::GetExtension($candidate).ToLowerInvariant()
            if (!$candidate.StartsWith($rootPath+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or !$mime.ContainsKey($extension) -or !(Test-Path -LiteralPath $candidate -PathType Leaf)) { Send-Json $stream 404 @{ok=$false;error='File not found'} $origin; continue }
            $bytes = [IO.File]::ReadAllBytes($candidate)
            Send-Response $stream 200 $bytes $mime[$extension] $origin
        } catch {
            if ($stream) { try { Send-Json $stream 502 @{ok=$false;status=502;error='Bridge request failed. Check portal address, internet access and server configuration.'} '' } catch {} }
        } finally { if ($stream) { $stream.Dispose() }; $client.Dispose() }
    }
} finally { $listener.Stop();$httpClient.Dispose();$handler.Dispose() }
