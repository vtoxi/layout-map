<?php
/**
 * PHP mirror of server.mjs API for Windows/IIS (Plesk) hosting.
 * Routes: /api/* rewritten here via web.config
 */
declare(strict_types=1);

header('Access-Control-Allow-Origin: ' . (getenv('A15_CORS') ?: '*'));
header('Access-Control-Allow-Methods: GET,PUT,POST,PATCH,DELETE,OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-User, X-Model-Id, X-HTTP-Method-Override');
header('Cache-Control: no-store');
$frameAncestors = getenv('A15_FRAME_ANCESTORS') ?: 'http://192.168.1.100:8080 http://127.0.0.1:8080';
header('Content-Security-Policy: frame-ancestors ' . $frameAncestors);

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

$ROOT = __DIR__;
$LAYOUT = $ROOT . DIRECTORY_SEPARATOR . 'layout.json';
$MODELS_DIR = $ROOT . DIRECTORY_SEPARATOR . 'models';
$INDEX_PATH = $MODELS_DIR . DIRECTORY_SEPARATOR . 'index.json';
$ASSETS = $ROOT . DIRECTORY_SEPARATOR . 'assets';
$DATA_DIR = $ROOT . DIRECTORY_SEPARATOR . 'data';
$USERS_PATH = $DATA_DIR . DIRECTORY_SEPARATOR . 'users.json';
$SESSIONS_PATH = $DATA_DIR . DIRECTORY_SEPARATOR . 'sessions.json';
$MAX_BODY = 28 * 1024 * 1024;
$AUTH_ENV = getenv('A15_AUTH'); // "1" enforce sessions

if (!is_dir($ASSETS)) mkdir($ASSETS, 0775, true);
if (!is_dir($MODELS_DIR)) mkdir($MODELS_DIR, 0775, true);
if (!is_dir($DATA_DIR)) mkdir($DATA_DIR, 0775, true);

function send_json(int $code, $obj): void {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  if ($code >= 400 && is_array($obj) && !array_key_exists('ok', $obj)) {
    $obj = array_merge(['ok' => false], $obj);
  }
  echo json_encode($obj, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
  exit;
}

function send_err(int $code, string $error, string $errCode = 'error'): void {
  send_json($code, ['ok' => false, 'error' => $error, 'code' => $errCode]);
}

function send_text(int $code, string $body, string $type = 'text/plain; charset=utf-8'): void {
  http_response_code($code);
  header('Content-Type: ' . $type);
  echo $body;
  exit;
}

function read_body(): string {
  global $MAX_BODY;
  $raw = file_get_contents('php://input');
  if ($raw === false) return '';
  if (strlen($raw) > $MAX_BODY) {
    send_err(413, 'body too large', 'body_too_large');
  }
  return $raw;
}

function parse_json_body(?string $raw = null): array {
  $raw = $raw ?? read_body();
  if ($raw === null || trim($raw) === '') return [];
  $j = json_decode($raw, true);
  if (!is_array($j)) send_err(400, 'invalid JSON', 'invalid_json');
  return $j;
}

function uid(string $prefix = 'id'): string {
  return $prefix . '_' . bin2hex(random_bytes(5));
}

function now_iso(): string {
  $dt = new DateTimeImmutable('now', new DateTimeZone('UTC'));
  return $dt->format('Y-m-d\TH:i:s.v\Z');
}

function auth_enforced(): bool {
  global $AUTH_ENV;
  return $AUTH_ENV === '1';
}

function empty_doc(): array {
  return [
    'version' => 2,
    'updatedAt' => now_iso(),
    'gridMm' => 50,
    'snapMm' => 50,
    'units' => 'metric',
    'wallHeightMm' => 2600,
    'wallThicknessMm' => 120,
    'flooring' => 'hardwood',
    'layers' => [],
    'walls' => [],
    'openings' => [],
    'doors' => [],
    'windows' => [],
    'lights' => [],
    'fans' => [],
    'sockets' => [],
    'cabinets' => [],
    'rooms' => [],
    'images' => [],
    'groups' => [],
  ];
}

function atomic_write(string $path, string $data): void {
  $dir = dirname($path);
  if (!is_dir($dir)) mkdir($dir, 0775, true);
  $tmp = $path . '.' . getmypid() . '.' . bin2hex(random_bytes(3)) . '.tmp';
  file_put_contents($tmp, $data);
  rename($tmp, $path);
}

function read_json_file(string $path, array $fallback): array {
  if (!is_file($path)) return $fallback;
  $j = json_decode((string)file_get_contents($path), true);
  return is_array($j) ? $j : $fallback;
}

function write_json_file(string $path, array $obj): void {
  atomic_write($path, json_encode($obj, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

function read_index(): array {
  global $INDEX_PATH;
  return read_json_file($INDEX_PATH, ['models' => []]);
}

function write_index(array $idx): void {
  global $INDEX_PATH;
  write_json_file($INDEX_PATH, $idx);
}

function write_current(string $id, array $doc): array {
  $doc['updatedAt'] = now_iso();
  $doc['modelId'] = $id;
  if (!isset($doc['version'])) $doc['version'] = 2;
  atomic_write(current_path($id), json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  sync_layout_mirror($doc);
  return $doc;
}

function model_dir(string $id): string {
  global $MODELS_DIR;
  return $MODELS_DIR . DIRECTORY_SEPARATOR . $id;
}

function current_path(string $id): string {
  return model_dir($id) . DIRECTORY_SEPARATOR . 'current.json';
}

function version_path(string $id, string $vid): string {
  return model_dir($id) . DIRECTORY_SEPARATOR . 'versions' . DIRECTORY_SEPARATOR . $vid . '.json';
}

function find_model(array $idx, ?string $id): ?array {
  if ($id === null || $id === '') return null;
  foreach ($idx['models'] ?? [] as $i => $m) {
    if (($m['id'] ?? null) === $id) {
      $m['_index'] = $i;
      return $m;
    }
  }
  return null;
}

function sync_layout_mirror(array $doc): void {
  global $LAYOUT;
  @atomic_write($LAYOUT, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

function read_current(string $id): array {
  $j = json_decode((string)file_get_contents(current_path($id)), true);
  if (!is_array($j)) throw new RuntimeException('invalid current.json');
  return $j;
}

function public_model(array $m, bool $includeShares = false): array {
  $versions = $m['versions'] ?? [];
  $latest = count($versions) ? $versions[count($versions) - 1] : null;
  $out = [
    'id' => $m['id'],
    'name' => $m['name'],
    'owner' => $m['owner'],
    'ownerUserId' => $m['ownerUserId'] ?? null,
    'createdAt' => $m['createdAt'],
    'updatedAt' => $m['updatedAt'],
    'versionCount' => count($versions),
    'latestVersion' => $latest,
    'versions' => $versions,
  ];
  if ($includeShares) {
    $out['shares'] = [];
    foreach ($m['shares'] ?? [] as $s) {
      if (!empty($s['revoked'])) continue;
      $out['shares'][] = [
        'id' => $s['id'],
        'label' => $s['label'] ?? '',
        'versionId' => $s['versionId'] ?? null,
        'createdAt' => $s['createdAt'] ?? null,
        'expiresAt' => $s['expiresAt'] ?? null,
      ];
    }
  }
  return $out;
}

function ensure_migrated(): array {
  global $LAYOUT;
  $idx = read_index();
  if (!empty($idx['models'])) return $idx;

  $seed = empty_doc();
  if (is_file($LAYOUT)) {
    $j = json_decode((string)file_get_contents($LAYOUT), true);
    if (is_array($j)) $seed = $j;
  }
  $id = uid('mdl');
  $vid = uid('v');
  $owner = 'local';
  $t = now_iso();
  $dir = model_dir($id) . DIRECTORY_SEPARATOR . 'versions';
  if (!is_dir($dir)) mkdir($dir, 0775, true);
  $doc = $seed;
  $doc['updatedAt'] = $t;
  $doc['modelId'] = $id;
  atomic_write(current_path($id), json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  $snap = $doc;
  $snap['_version'] = ['id' => $vid, 'label' => 'v1 · Initial', 'note' => 'Migrated from layout.json', 'createdAt' => $t];
  atomic_write(version_path($id, $vid), json_encode($snap, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  $idx['models'] = [[
    'id' => $id,
    'name' => 'Apartment #15',
    'owner' => $owner,
    'ownerUserId' => null,
    'createdAt' => $t,
    'updatedAt' => $t,
    'versions' => [['id' => $vid, 'label' => 'v1 · Initial', 'note' => 'Migrated from layout.json', 'createdAt' => $t]],
    'shares' => [],
  ]];
  write_index($idx);
  sync_layout_mirror($doc);
  return $idx;
}

function update_meta(array &$idx, array $meta): void {
  $i = $meta['_index'] ?? null;
  unset($meta['_index']);
  if ($i === null) {
    foreach ($idx['models'] as $k => $m) {
      if (($m['id'] ?? null) === ($meta['id'] ?? null)) { $i = $k; break; }
    }
  }
  if ($i !== null) $idx['models'][$i] = $meta;
}

/* ——— Auth ——— */
function read_users(): array {
  global $USERS_PATH;
  return read_json_file($USERS_PATH, ['users' => []]);
}
function write_users(array $u): void {
  global $USERS_PATH;
  write_json_file($USERS_PATH, $u);
}
function read_sessions(): array {
  global $SESSIONS_PATH;
  return read_json_file($SESSIONS_PATH, ['sessions' => []]);
}
function write_sessions(array $s): void {
  global $SESSIONS_PATH;
  write_json_file($SESSIONS_PATH, $s);
}

function hash_token(string $token): string {
  return hash('sha256', $token);
}

function random_token(int $bytes = 24): string {
  return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
}

function hash_password(string $password): string {
  $salt = random_bytes(16);
  $iter = 120000;
  $hash = hash_pbkdf2('sha256', $password, $salt, $iter, 32, true);
  return 'pbkdf2$' . $iter . '$' . bin2hex($salt) . '$' . bin2hex($hash);
}

function verify_password(string $password, string $stored): bool {
  $parts = explode('$', $stored);
  if (($parts[0] ?? '') === 'pbkdf2') {
    $iter = (int)($parts[1] ?? 120000);
    $salt = @hex2bin($parts[2] ?? '');
    $expect = @hex2bin($parts[3] ?? '');
    if ($salt === false || $expect === false) return false;
    $hash = hash_pbkdf2('sha256', $password, $salt, $iter, strlen($expect), true);
    return hash_equals($expect, $hash);
  }
  // bcrypt / argon from older password_hash()
  if (str_starts_with($stored, '$2y$') || str_starts_with($stored, '$2a$') || str_starts_with($stored, '$argon')) {
    return password_verify($password, $stored);
  }
  return false;
}

function public_user(array $u): array {
  return [
    'id' => $u['id'],
    'email' => $u['email'],
    'name' => $u['name'] ?? '',
    'plan' => $u['plan'] ?? 'free',
    'createdAt' => $u['createdAt'] ?? null,
  ];
}

function bearer_token(): string {
  $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
  if ($h === '' && function_exists('apache_request_headers')) {
    $headers = apache_request_headers();
    foreach ($headers as $k => $v) {
      if (strcasecmp($k, 'Authorization') === 0) { $h = $v; break; }
    }
  }
  if (preg_match('/^Bearer\s+(.+)$/i', $h, $m)) return trim($m[1]);
  return '';
}

function get_session_user(): ?array {
  $token = bearer_token();
  if ($token === '') return null;
  // Share tokens are public read credentials — never treat as sessions
  $idx = ensure_migrated();
  $th = hash_token($token);
  foreach ($idx['models'] ?? [] as $m) {
    foreach ($m['shares'] ?? [] as $s) {
      if (($s['tokenHash'] ?? '') === $th && empty($s['revoked'])) return null;
    }
  }
  $store = read_sessions();
  $now = time();
  $store['sessions'] = array_values(array_filter($store['sessions'] ?? [], function ($s) use ($now) {
    return strtotime((string)($s['expiresAt'] ?? '')) > $now;
  }));
  write_sessions($store);
  $sess = null;
  foreach ($store['sessions'] as $s) {
    if (($s['tokenHash'] ?? '') === $th) { $sess = $s; break; }
  }
  if (!$sess) return null;
  $users = read_users();
  foreach ($users['users'] ?? [] as $u) {
    if (($u['id'] ?? '') === ($sess['userId'] ?? '')) return $u;
  }
  return null;
}

function reject_share_bearer(): void {
  $token = bearer_token();
  if ($token === '') return;
  $idx = ensure_migrated();
  $th = hash_token($token);
  foreach ($idx['models'] ?? [] as $m) {
    foreach ($m['shares'] ?? [] as $s) {
      if (($s['tokenHash'] ?? '') === $th && empty($s['revoked'])) {
        send_err(403, 'share tokens are read-only', 'share_readonly');
      }
    }
  }
}

function can_access_model(?array $user, ?array $meta, bool $mutate = false): bool {
  if (!$meta) return false;
  if (!auth_enforced() && !$user) return true;
  if (!$user) return false;
  if (!empty($meta['ownerUserId']) && $meta['ownerUserId'] === $user['id']) return true;
  if (empty($meta['ownerUserId']) && ($meta['owner'] ?? '') === ($user['email'] ?? '')) return true;
  if (empty($meta['ownerUserId']) && ($meta['owner'] ?? '') === 'local' && !$mutate) return true;
  return false;
}

function assert_model_access(?array $meta, bool $mutate = true): ?array {
  if ($mutate) reject_share_bearer();
  $user = get_session_user();
  if (!auth_enforced()) return $user;
  if (!$user) send_err(401, 'authentication required', 'auth_required');
  if (!can_access_model($user, $meta, $mutate)) send_err(403, 'forbidden', 'forbidden');
  return $user;
}

function room_points(array $r): array {
  if (!empty($r['points']) && is_array($r['points']) && count($r['points']) >= 3) return $r['points'];
  if (isset($r['w'], $r['h'])) {
    $x = (float)($r['x'] ?? 0);
    $y = (float)($r['y'] ?? 0);
    $w = (float)$r['w'];
    $h = (float)$r['h'];
    return [
      ['x' => $x, 'y' => $y],
      ['x' => $x + $w, 'y' => $y],
      ['x' => $x + $w, 'y' => $y + $h],
      ['x' => $x, 'y' => $y + $h],
    ];
  }
  return [];
}

function polygon_area_mm2(array $pts): float {
  if (count($pts) < 3) return 0.0;
  $a = 0.0;
  $n = count($pts);
  for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
    $a += ((float)$pts[$j]['x']) * ((float)$pts[$i]['y']) - ((float)$pts[$i]['x']) * ((float)$pts[$j]['y']);
  }
  return abs($a) / 2.0;
}

function build_area_schedule(array $doc): array {
  $rows = [];
  foreach ($doc['rooms'] ?? [] as $r) {
    $pts = room_points($r);
    $mm2 = polygon_area_mm2($pts);
    $rows[] = [
      'id' => $r['id'] ?? '',
      'label' => $r['label'] ?? ($r['id'] ?? ''),
      'areaMm2' => (int)round($mm2),
      'areaM2' => round($mm2 / 1e6, 2),
      'sides' => count($pts),
    ];
  }
  return $rows;
}

function area_schedule_csv(array $doc): string {
  $lines = ['id,label,area_m2,area_mm2,sides'];
  foreach (build_area_schedule($doc) as $r) {
    $label = str_replace('"', '""', (string)$r['label']);
    $lines[] = "{$r['id']},\"{$label}\",{$r['areaM2']},{$r['areaMm2']},{$r['sides']}";
  }
  return implode("\n", $lines) . "\n";
}

function doc_counts(array $doc): array {
  return [
    'walls' => count($doc['walls'] ?? []),
    'doors' => count($doc['doors'] ?? []),
    'windows' => count($doc['windows'] ?? []),
    'rooms' => count($doc['rooms'] ?? []),
    'lights' => count($doc['lights'] ?? []),
    'fans' => count($doc['fans'] ?? []),
    'sockets' => count($doc['sockets'] ?? []),
    'furniture' => count($doc['cabinets'] ?? []),
    'images' => count($doc['images'] ?? []),
  ];
}

function oh_sanitize(string $s): string {
  $s = preg_replace('/[^a-zA-Z0-9_]+/', '_', $s) ?? 'x';
  $s = trim($s, '_');
  $s = preg_replace('/_+/', '_', $s) ?? 'x';
  return substr($s !== '' ? $s : 'x', 0, 48);
}

function oh_item_name(string $kind, array $obj): string {
  if (!empty($obj['ohItem'])) return oh_sanitize((string)$obj['ohItem']);
  $prefix = [
    'door' => 'Door', 'window' => 'Window', 'cabinet' => 'Cabinet',
    'light' => 'Light', 'fan' => 'Fan',
  ][$kind] ?? 'Dev';
  return 'A15_' . $prefix . '_' . oh_sanitize((string)($obj['id'] ?? 'unknown'));
}

function oh_generate_items(array $doc, string $modelName): string {
  $lines = [
    '// Apartment15 → openHAB Items',
    '// Model: ' . $modelName,
    '// Generated: ' . now_iso(),
    '',
    'Group A15_Apartment "' . str_replace('"', "'", $modelName) . '"',
    '',
  ];
  $add = function (string $kind, array $list) use (&$lines) {
    foreach ($list as $o) {
      if ($kind === 'window' && (($o['style'] ?? '') === 'fixed')) continue;
      $item = oh_item_name($kind, $o);
      $label = str_replace('"', "'", (string)($o['label'] ?? $kind));
      $lines[] = 'Switch ' . $item . ' "' . $label . '" (A15_Apartment)';
    }
  };
  $add('door', $doc['doors'] ?? []);
  $add('window', $doc['windows'] ?? []);
  $add('cabinet', $doc['cabinets'] ?? []);
  $add('light', $doc['lights'] ?? []);
  $add('fan', $doc['fans'] ?? []);
  $lines[] = '';
  return implode("\n", $lines);
}

function oh_generate_page_yaml(string $modelName, string $publicUrl, string $modelId): string {
  $base = rtrim($publicUrl, '/');
  $url2d = $modelId !== '' ? $base . '/index.html?model=' . rawurlencode($modelId) : $base . '/index.html';
  $url3d = $modelId !== ''
    ? $base . '/preview3d.html?model=' . rawurlencode($modelId) . '&view=1'
    : $base . '/preview3d.html?view=1';
  return "config:\n  label: " . json_encode($modelName . ' · Floor') . "\n  sidebar: true\n"
    . "blocks:\n  - component: oh-block\n    config:\n      title: 2D plan\n    slots:\n      default:\n"
    . "        - component: oh-grid-row\n          config: {}\n          slots:\n            default:\n"
    . "              - component: oh-grid-col\n                config:\n                  width: 100\n                slots:\n"
    . "                  default:\n                    - component: oh-webframe-card\n                      config:\n"
    . "                        src: " . json_encode($url2d) . "\n                        height: 520\n                        noBorder: true\n"
    . "  - component: oh-block\n    config:\n      title: 3D preview\n    slots:\n      default:\n"
    . "        - component: oh-grid-row\n          config: {}\n          slots:\n            default:\n"
    . "              - component: oh-grid-col\n                config:\n                  width: 100\n                slots:\n"
    . "                  default:\n                    - component: oh-webframe-card\n                      config:\n"
    . "                        src: " . json_encode($url3d) . "\n                        height: 640\n                        noBorder: true\n"
    . "masonry: null\ngrid: []\ncanvas: []\n";
}

function collect_asset_files(array $doc): array {
  global $ASSETS;
  $files = [];
  foreach ($doc['images'] ?? [] as $im) {
    $src = (string)($im['src'] ?? '');
    if (preg_match('#^\.?/?assets/([^/?#]+)$#', $src, $m)) {
      $fp = $ASSETS . DIRECTORY_SEPARATOR . $m[1];
      if (is_file($fp)) $files[] = ['name' => 'assets/' . $m[1], 'path' => $fp];
    }
  }
  return $files;
}

function api_path(): string {
  if (isset($_GET['__path'])) {
    return trim((string)$_GET['__path'], '/');
  }
  $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
  if (preg_match('#/api(?:\.php)?/?(.*)$#', $uri, $m)) {
    return trim($m[1], '/');
  }
  return '';
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'POST') {
  $override = $_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']
    ?? $_SERVER['HTTP_X_METHOD_OVERRIDE']
    ?? ($_GET['_method'] ?? null);
  if (is_string($override) && $override !== '') {
    $method = strtoupper($override);
  }
}
$path = api_path();
$parts = $path === '' ? [] : explode('/', $path);
$reqId = bin2hex(random_bytes(4));
$started = microtime(true);

try {
  ensure_migrated();
  if (!is_file($USERS_PATH)) write_users(['users' => []]);
  if (!is_file($SESSIONS_PATH)) write_sessions(['sessions' => []]);

  // /api/health
  if (($parts[0] ?? '') === 'health') {
    $writable = false;
    try {
      atomic_write($DATA_DIR . DIRECTORY_SEPARATOR . '.health', 'ok');
      $writable = true;
    } catch (Throwable $e) { /* */ }
    $idx = read_index();
    send_json(200, [
      'ok' => true,
      'writable' => $writable,
      'models' => count($idx['models'] ?? []),
      'auth' => auth_enforced(),
      'time' => now_iso(),
    ]);
  }

  // /api/auth/*
  if (($parts[0] ?? '') === 'auth') {
    $action = $parts[1] ?? '';
    if ($action === 'register' && $method === 'POST') {
      $body = parse_json_body();
      $email = strtolower(trim((string)($body['email'] ?? '')));
      $password = (string)($body['password'] ?? '');
      $name = trim(substr((string)($body['name'] ?? ''), 0, 80));
      if (!filter_var($email, FILTER_VALIDATE_EMAIL)) send_err(400, 'invalid email', 'invalid_email');
      if (strlen($password) < 8) send_err(400, 'password must be at least 8 characters', 'weak_password');
      $store = read_users();
      foreach ($store['users'] as $u) {
        if (($u['email'] ?? '') === $email) send_err(409, 'email already registered', 'email_taken');
      }
      $user = [
        'id' => uid('usr'),
        'email' => $email,
        'name' => $name !== '' ? $name : explode('@', $email)[0],
        'passwordHash' => hash_password($password),
        'plan' => 'free',
        'createdAt' => now_iso(),
      ];
      $store['users'][] = $user;
      write_users($store);
      $token = random_token(32);
      $sessions = read_sessions();
      $sessions['sessions'][] = [
        'tokenHash' => hash_token($token),
        'userId' => $user['id'],
        'expiresAt' => (new DateTimeImmutable('+30 days'))->format('Y-m-d\TH:i:s.v\Z'),
      ];
      write_sessions($sessions);
      send_json(201, ['ok' => true, 'user' => public_user($user), 'token' => $token]);
    }
    if ($action === 'login' && $method === 'POST') {
      $body = parse_json_body();
      $email = strtolower(trim((string)($body['email'] ?? '')));
      $password = (string)($body['password'] ?? '');
      $store = read_users();
      $user = null;
      foreach ($store['users'] as $u) {
        if (($u['email'] ?? '') === $email) { $user = $u; break; }
      }
      if (!$user || !verify_password($password, (string)($user['passwordHash'] ?? ''))) {
        send_err(401, 'invalid email or password', 'invalid_credentials');
      }
      $token = random_token(32);
      $sessions = read_sessions();
      $sessions['sessions'][] = [
        'tokenHash' => hash_token($token),
        'userId' => $user['id'],
        'expiresAt' => (new DateTimeImmutable('+30 days'))->format('Y-m-d\TH:i:s.v\Z'),
      ];
      write_sessions($sessions);
      send_json(200, ['ok' => true, 'user' => public_user($user), 'token' => $token]);
    }
    if ($action === 'logout' && $method === 'POST') {
      $token = bearer_token();
      if ($token !== '') {
        $th = hash_token($token);
        $sessions = read_sessions();
        $sessions['sessions'] = array_values(array_filter(
          $sessions['sessions'] ?? [],
          fn($s) => ($s['tokenHash'] ?? '') !== $th
        ));
        write_sessions($sessions);
      }
      send_json(200, ['ok' => true]);
    }
    if ($action === 'me' && $method === 'GET') {
      $user = get_session_user();
      if (!$user) send_err(401, 'authentication required', 'auth_required');
      send_json(200, ['ok' => true, 'user' => public_user($user)]);
    }
    send_err(404, 'not found', 'not_found');
  }

  // /api/shares/{token}
  if (($parts[0] ?? '') === 'shares' && count($parts) === 2 && $method === 'GET') {
    $token = $parts[1];
    $idx = ensure_migrated();
    $th = hash_token($token);
    $hit = null;
    foreach ($idx['models'] ?? [] as $m) {
      foreach ($m['shares'] ?? [] as $s) {
        if (($s['tokenHash'] ?? '') === $th) { $hit = ['model' => $m, 'share' => $s]; break 2; }
      }
    }
    if (!$hit || !empty($hit['share']['revoked'])) send_err(404, 'share not found', 'share_not_found');
    if (!empty($hit['share']['expiresAt']) && strtotime($hit['share']['expiresAt']) < time()) {
      send_err(410, 'share expired', 'share_expired');
    }
    $mid = $hit['model']['id'];
    if (!empty($hit['share']['versionId'])) {
      $snap = json_decode((string)file_get_contents(version_path($mid, $hit['share']['versionId'])), true);
      unset($snap['_version']);
      $doc = $snap;
    } else {
      $doc = read_current($mid);
    }
    send_json(200, [
      'ok' => true,
      'model' => ['id' => $mid, 'name' => $hit['model']['name']],
      'share' => [
        'id' => $hit['share']['id'],
        'label' => $hit['share']['label'] ?? '',
        'versionId' => $hit['share']['versionId'] ?? null,
      ],
      'doc' => $doc,
    ]);
  }

  // /api/models/{id}/shares
  if (($parts[0] ?? '') === 'models' && count($parts) === 3 && $parts[2] === 'shares') {
    $id = $parts[1];
    $idx = ensure_migrated();
    $meta = find_model($idx, $id);
    if (!$meta) send_err(404, 'model not found', 'not_found');
    assert_model_access($meta, true);
    if ($method === 'POST') {
      $body = parse_json_body();
      $token = random_token(24);
      $share = [
        'id' => uid('shr'),
        'tokenHash' => hash_token($token),
        'label' => trim(substr((string)($body['label'] ?? 'Public link'), 0, 80)),
        'versionId' => $body['versionId'] ?? null,
        'createdAt' => now_iso(),
        'expiresAt' => $body['expiresAt'] ?? null,
        'revoked' => false,
      ];
      if ($share['versionId']) {
        $okV = false;
        foreach ($meta['versions'] ?? [] as $v) {
          if (($v['id'] ?? '') === $share['versionId']) { $okV = true; break; }
        }
        if (!$okV) send_err(400, 'version not found', 'version_missing');
      }
      $meta['shares'] = $meta['shares'] ?? [];
      $meta['shares'][] = $share;
      $meta['updatedAt'] = now_iso();
      update_meta($idx, $meta);
      write_index($idx);
      send_json(201, [
        'ok' => true,
        'share' => [
          'id' => $share['id'],
          'label' => $share['label'],
          'versionId' => $share['versionId'],
          'createdAt' => $share['createdAt'],
          'expiresAt' => $share['expiresAt'],
          'token' => $token,
          'url' => '/view.html?t=' . rawurlencode($token),
        ],
      ]);
    }
    if ($method === 'GET') {
      send_json(200, ['ok' => true, 'shares' => public_model($meta, true)['shares']]);
    }
    send_err(405, 'Method not allowed', 'method');
  }

  // /api/models/{id}/shares/{sid} DELETE
  if (($parts[0] ?? '') === 'models' && count($parts) === 4 && $parts[2] === 'shares' && $method === 'DELETE') {
    $id = $parts[1];
    $sid = $parts[3];
    $idx = ensure_migrated();
    $meta = find_model($idx, $id);
    if (!$meta) send_err(404, 'model not found', 'not_found');
    assert_model_access($meta, true);
    foreach ($meta['shares'] ?? [] as $i => $s) {
      if (($s['id'] ?? '') === $sid) $meta['shares'][$i]['revoked'] = true;
    }
    $meta['updatedAt'] = now_iso();
    update_meta($idx, $meta);
    write_index($idx);
    send_json(200, ['ok' => true]);
  }

  // /api/models/{id}/export
  if (($parts[0] ?? '') === 'models' && count($parts) === 3 && $parts[2] === 'export' && $method === 'POST') {
    $id = $parts[1];
    $idx = ensure_migrated();
    $meta = find_model($idx, $id);
    if (!$meta) send_err(404, 'model not found', 'not_found');
    assert_model_access($meta, false);
    $body = parse_json_body();
    if (!empty($body['versionId'])) {
      $snap = json_decode((string)file_get_contents(version_path($id, $body['versionId'])), true);
      unset($snap['_version']);
      $doc = $snap;
    } else {
      $doc = read_current($id);
    }
    if (!class_exists('ZipArchive')) {
      send_err(500, 'ZipArchive not available on this host', 'zip_unavailable');
    }
    $tmp = tempnam(sys_get_temp_dir(), 'a15zip');
    $zip = new ZipArchive();
    $zip->open($tmp, ZipArchive::OVERWRITE);
    $zip->addFromString('layout.json', json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    $zip->addFromString('meta.json', json_encode([
      'modelId' => $id,
      'name' => $meta['name'],
      'exportedAt' => now_iso(),
      'counts' => doc_counts($doc),
      'areas' => build_area_schedule($doc),
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    $zip->addFromString('areas.csv', area_schedule_csv($doc));
    $zip->addFromString('README.txt', "Apartment15 export pack\nModel: {$meta['name']}\nExported: " . now_iso() . "\n\nOpen layout.json in the CAD editor (Import JSON).\nSee openhab/ for Pi + openHAB Items and MainUI page YAML.\n");
    $publicUrl = getenv('A15_PUBLIC_URL') ?: 'http://192.168.1.100:8765';
    $zip->addFromString('openhab/apartment15.items', oh_generate_items($doc, (string)$meta['name']));
    $zip->addFromString('openhab/pages/apartment15.yaml', oh_generate_page_yaml((string)$meta['name'], $publicUrl, $id));
    $zip->addFromString('openhab/README.txt', "Copy apartment15.items to /etc/openhab/items/\nPaste pages/apartment15.yaml into MainUI Pages.\nSee deploy/pi/README-PI.md on the Node/Pi host for full setup.\n");
    foreach (collect_asset_files($doc) as $f) {
      $zip->addFile($f['path'], $f['name']);
    }
    $zip->close();
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . preg_replace('/[^a-zA-Z0-9._-]+/', '_', $meta['name']) . '.zip"');
    readfile($tmp);
    @unlink($tmp);
    exit;
  }

  // /api/asset
  if (($parts[0] ?? '') === 'asset') {
    if ($method === 'POST') {
      if (auth_enforced() && !get_session_user()) send_err(401, 'authentication required', 'auth_required');
      $parsed = parse_json_body();
      $dataUrl = (string)($parsed['dataUrl'] ?? '');
      if (!preg_match('#^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$#', $dataUrl, $m)) {
        send_err(400, 'expected data URL image', 'invalid_input');
      }
      $mime = strtolower($m[1]);
      $ext = (strpos($mime, 'jpeg') !== false || strpos($mime, 'jpg') !== false) ? '.jpg'
        : (strpos($mime, 'webp') !== false ? '.webp'
          : (strpos($mime, 'gif') !== false ? '.gif' : '.png'));
      $safeBase = preg_replace('/[^a-zA-Z0-9._-]+/', '_', (string)($parsed['name'] ?? 'trace')) ?: 'trace';
      $safeBase = substr($safeBase, 0, 40);
      $fileName = (string)round(microtime(true) * 1000) . '_' . $safeBase . $ext;
      $buf = base64_decode($m[2], true);
      if ($buf === false) send_err(400, 'bad base64', 'invalid_input');
      if (strlen($buf) > 25 * 1024 * 1024) send_err(400, 'image too large (25MB max)', 'too_large');
      file_put_contents($ASSETS . DIRECTORY_SEPARATOR . $fileName, $buf);
      send_json(200, ['ok' => true, 'url' => './assets/' . $fileName, 'name' => $fileName]);
    }
    send_err(405, 'Method not allowed', 'method');
  }

  // /api/models
  if (($parts[0] ?? '') === 'models' && count($parts) === 1) {
    $idx = ensure_migrated();
    if ($method === 'GET') {
      $user = get_session_user();
      $list = $idx['models'] ?? [];
      if ($user) {
        $list = array_values(array_filter($list, function ($m) use ($user) {
          return (($m['ownerUserId'] ?? null) === $user['id'])
            || (empty($m['ownerUserId']) && (($m['owner'] ?? '') === $user['email'] || ($m['owner'] ?? '') === ($_SERVER['HTTP_X_USER'] ?? '')));
        }));
      } elseif (!auth_enforced()) {
        $owner = $_GET['owner'] ?? null;
        if ($owner !== null && $owner !== '') {
          $list = array_values(array_filter($list, fn($m) => ($m['owner'] ?? '') === $owner || ($m['owner'] ?? '') === 'local'));
        }
      } else {
        send_err(401, 'authentication required', 'auth_required');
      }
      send_json(200, ['ok' => true, 'models' => array_map(fn($m) => public_model($m, true), $list)]);
    }
    if ($method === 'POST') {
      $user = get_session_user();
      if (auth_enforced() && !$user) send_err(401, 'authentication required', 'auth_required');
      $body = parse_json_body();
      $owner = $user['email'] ?? trim(substr((string)($body['owner'] ?? ($_SERVER['HTTP_X_USER'] ?? 'local')), 0, 64)) ?: 'local';
      $name = trim(substr((string)($body['name'] ?? 'Untitled model'), 0, 80)) ?: 'Untitled model';
      $source = $body['source'] ?? 'empty';
      $doc = empty_doc();
      if ($source === 'layout' || $source === 'current') {
        if (is_file($LAYOUT)) {
          $j = json_decode((string)file_get_contents($LAYOUT), true);
          if (is_array($j)) $doc = $j;
        }
      } elseif ($source === 'model' && !empty($body['copyFromId'])) {
        $srcMeta = find_model($idx, (string)$body['copyFromId']);
        assert_model_access($srcMeta, false);
        $doc = read_current((string)$body['copyFromId']);
      } elseif (isset($body['doc']) && is_array($body['doc'])) {
        $doc = $body['doc'];
      }
      $id = uid('mdl');
      $vid = uid('v');
      $t = now_iso();
      $vdir = model_dir($id) . DIRECTORY_SEPARATOR . 'versions';
      if (!is_dir($vdir)) mkdir($vdir, 0775, true);
      $doc['modelId'] = $id;
      $doc['updatedAt'] = $t;
      atomic_write(current_path($id), json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
      $vLabel = 'v1 · Initial';
      $snap = $doc;
      $snap['_version'] = ['id' => $vid, 'label' => $vLabel, 'note' => $body['note'] ?? '', 'createdAt' => $t];
      atomic_write(version_path($id, $vid), json_encode($snap, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
      $meta = [
        'id' => $id,
        'name' => $name,
        'owner' => $owner,
        'ownerUserId' => $user['id'] ?? null,
        'createdAt' => $t,
        'updatedAt' => $t,
        'versions' => [['id' => $vid, 'label' => $vLabel, 'note' => $body['note'] ?? '', 'createdAt' => $t]],
        'shares' => [],
      ];
      $idx['models'][] = $meta;
      write_index($idx);
      send_json(201, ['ok' => true, 'model' => public_model($meta, true), 'doc' => $doc]);
    }
    send_err(405, 'Method not allowed', 'method');
  }

  // /api/models/{id}/versions/{vid}
  if (($parts[0] ?? '') === 'models' && count($parts) === 4 && $parts[2] === 'versions') {
    $id = $parts[1];
    $vid = $parts[3];
    $idx = ensure_migrated();
    $meta = find_model($idx, $id);
    if (!$meta) send_err(404, 'model not found', 'not_found');
    assert_model_access($meta, $method !== 'GET');
    $vmeta = null;
    foreach ($meta['versions'] ?? [] as $v) {
      if (($v['id'] ?? null) === $vid) { $vmeta = $v; break; }
    }
    if (!$vmeta) send_err(404, 'version not found', 'not_found');

    if ($method === 'GET') {
      $doc = json_decode((string)file_get_contents(version_path($id, $vid)), true);
      send_json(200, ['ok' => true, 'model' => public_model($meta, true), 'version' => $vmeta, 'doc' => $doc]);
    }
    if ($method === 'POST') {
      $snap = json_decode((string)file_get_contents(version_path($id, $vid)), true);
      if (!is_array($snap)) throw new RuntimeException('bad version');
      unset($snap['_version']);
      $doc = write_current($id, $snap);
      $meta['updatedAt'] = $doc['updatedAt'];
      update_meta($idx, $meta);
      write_index($idx);
      send_json(200, ['ok' => true, 'model' => public_model($meta, true), 'doc' => $doc, 'restoredFrom' => $vmeta]);
    }
    if ($method === 'DELETE') {
      if (count($meta['versions'] ?? []) <= 1) send_err(400, 'keep at least one version', 'last_version');
      @unlink(version_path($id, $vid));
      $meta['versions'] = array_values(array_filter($meta['versions'], fn($v) => ($v['id'] ?? null) !== $vid));
      $meta['updatedAt'] = now_iso();
      update_meta($idx, $meta);
      write_index($idx);
      send_json(200, ['ok' => true, 'model' => public_model($meta, true)]);
    }
    send_err(405, 'Method not allowed', 'method');
  }

  // /api/models/{id}/versions
  if (($parts[0] ?? '') === 'models' && count($parts) === 3 && $parts[2] === 'versions') {
    $id = $parts[1];
    $idx = ensure_migrated();
    $meta = find_model($idx, $id);
    if (!$meta) send_err(404, 'model not found', 'not_found');
    assert_model_access($meta, $method !== 'GET');
    if ($method === 'GET') {
      send_json(200, ['ok' => true, 'modelId' => $id, 'versions' => $meta['versions'] ?? []]);
    }
    if ($method === 'POST') {
      $body = parse_json_body();
      $doc = isset($body['doc']) && is_array($body['doc']) ? write_current($id, $body['doc']) : read_current($id);
      $vid = uid('v');
      $t = now_iso();
      $n = count($meta['versions'] ?? []) + 1;
      $label = trim(substr((string)($body['label'] ?? ("v$n")), 0, 80)) ?: "v$n";
      $note = trim(substr((string)($body['note'] ?? ''), 0, 240));
      $vdir = model_dir($id) . DIRECTORY_SEPARATOR . 'versions';
      if (!is_dir($vdir)) mkdir($vdir, 0775, true);
      $snap = $doc;
      $snap['updatedAt'] = $t;
      $snap['_version'] = ['id' => $vid, 'label' => $label, 'note' => $note, 'createdAt' => $t];
      atomic_write(version_path($id, $vid), json_encode($snap, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
      $meta['versions'][] = ['id' => $vid, 'label' => $label, 'note' => $note, 'createdAt' => $t];
      $meta['updatedAt'] = $t;
      update_meta($idx, $meta);
      write_index($idx);
      $versions = $meta['versions'];
      send_json(201, ['ok' => true, 'model' => public_model($meta, true), 'version' => $versions[count($versions) - 1]]);
    }
    send_err(405, 'Method not allowed', 'method');
  }

  // /api/models/{id}
  if (($parts[0] ?? '') === 'models' && count($parts) === 2) {
    $id = $parts[1];
    $idx = ensure_migrated();
    $meta = find_model($idx, $id);
    if (!$meta) send_err(404, 'model not found', 'not_found');
    assert_model_access($meta, $method !== 'GET');
    if ($method === 'GET') {
      send_json(200, ['ok' => true, 'model' => public_model($meta, true), 'doc' => read_current($id)]);
    }
    if ($method === 'PUT') {
      $body = parse_json_body();
      $docIn = isset($body['doc']) && is_array($body['doc']) ? $body['doc'] : $body;
      if (!is_array($docIn)) send_err(400, 'invalid doc', 'invalid_json');
      $doc = write_current($id, $docIn);
      $meta['updatedAt'] = $doc['updatedAt'];
      update_meta($idx, $meta);
      write_index($idx);
      send_json(200, ['ok' => true, 'model' => public_model($meta, true), 'doc' => $doc]);
    }
    if ($method === 'PATCH') {
      $body = parse_json_body();
      if (array_key_exists('name', $body)) {
        $meta['name'] = trim(substr((string)$body['name'], 0, 80)) ?: $meta['name'];
      }
      if (array_key_exists('owner', $body) && !auth_enforced()) {
        $meta['owner'] = trim(substr((string)$body['owner'], 0, 64)) ?: $meta['owner'];
      }
      $meta['updatedAt'] = now_iso();
      update_meta($idx, $meta);
      write_index($idx);
      send_json(200, ['ok' => true, 'model' => public_model($meta, true)]);
    }
    if ($method === 'DELETE') {
      $dir = model_dir($id);
      if (is_dir($dir)) {
        $it = new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS);
        $files = new RecursiveIteratorIterator($it, RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $f) {
          $f->isDir() ? rmdir($f->getPathname()) : unlink($f->getPathname());
        }
        rmdir($dir);
      }
      $idx['models'] = array_values(array_filter($idx['models'], fn($m) => ($m['id'] ?? null) !== $id));
      write_index($idx);
      send_json(200, ['ok' => true]);
    }
    send_err(405, 'Method not allowed', 'method');
  }

  // /api/layout
  if (($parts[0] ?? '') === 'layout') {
    $idx = ensure_migrated();
    $modelId = $_GET['model'] ?? ($_SERVER['HTTP_X_MODEL_ID'] ?? null) ?: ($idx['models'][0]['id'] ?? null);
    $meta = find_model($idx, $modelId);
    if (!$meta) send_err(404, 'no models', 'not_found');
    assert_model_access($meta, $method !== 'GET');
    if ($method === 'GET') {
      send_json(200, read_current($meta['id']));
    }
    if ($method === 'PUT') {
      $parsed = parse_json_body();
      $doc = write_current($meta['id'], $parsed);
      $meta['updatedAt'] = $doc['updatedAt'];
      update_meta($idx, $meta);
      write_index($idx);
      send_json(200, $doc);
    }
    send_err(405, 'Method not allowed', 'method');
  }

  send_err(404, 'not found', 'not_found');
} catch (Throwable $err) {
  $code = ($err->getCode() >= 400 && $err->getCode() < 600) ? (int)$err->getCode() : 400;
  send_json($code, ['ok' => false, 'error' => $err->getMessage(), 'code' => 'error']);
} finally {
  // Structured-ish access log (IIS / PHP-FPM)
  $ms = (int)round((microtime(true) - $started) * 1000);
  error_log(json_encode([
    't' => date('c'),
    'id' => $reqId,
    'method' => $method,
    'path' => '/api/' . $path,
    'ms' => $ms,
  ]));
}
