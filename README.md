# code-server-omp-docker

code-server (VS Code trong browser) + oh-my-pi (omp coding agent) trong một Docker image, với kiến trúc 3-tier tool và DinD tùy chọn.

## Yêu cầu

- Docker Engine + Docker Compose
- ~4GB RAM, ~2GB disk

## Quick start

```bash
git clone https://github.com/SilverKnightKMA/code-server-omp-docker.git
cd code-server-omp-docker

# 1. Tạo toàn bộ data directories (bao gồm dedicated code-server mounts)
mkdir -p \
  data/workspaces \
  data/ssh \
  data/config/git data/config/gh data/config/code-server \
  data/code-server-data data/code-server-cache \
  data/npm-global data/bun \
  data/local-bin data/local-go data/local-pip \
  data/cargo data/rustup data/go \
  data/code-server-omp-cache data/tmux-state \
  data/entrypoint.d

# 2. Set ownership (UID 1000 = coder trong container)
# Bỏ qua nếu data/ chưa tồn tại; chạy sau khi tạo lần đầu.
sudo chown -R 1000:1000 \
  data/workspaces \
  data/ssh \
  data/config data/code-server-data data/code-server-cache \
  data/npm-global data/bun \
  data/local-bin data/local-go data/local-pip \
  data/cargo data/rustup data/go \
  data/code-server-omp-cache data/tmux-state \
  data/entrypoint.d

# KHÔNG chown /var/lib/docker hoặc /var/lib/containerd

# 3. Build image
docker compose build

# 4. Start container
docker compose up -d

# 5. Mở http://localhost:8880
```

Mặc định, `omp` và các managed tools khác chỉ được cài vào volume khi bạn bật `CODE_SERVER_OMP_AUTOINSTALL: "true"` trong compose hoặc chạy `npm run --prefix /opt/code-server-omp/managed-tools managed-tools:init` bên trong container.

## Host-side preparation (chi tiết)

### Tạo data directories

Tất cả volume mounts cần thư mục host tương ứng. Nếu thiếu, Docker tự tạo với quyền
`root:root`. Khi container chạy với `user: root` (bắt buộc cho DinD), entrypoint
sẽ tạo subdirs và chown chúng. Nhưng host-prep giúp tránh lỗi ngay từ đầu.

### Set ownership

UID 1000 trong container là `coder`. Để bind-mounted directories có thể write:

```bash
sudo chown 1000:1000 \
  data/workspaces \
  data/config data/code-server-data data/code-server-cache \
  data/npm-global data/bun \
  data/local-bin data/local-go data/local-pip \
  data/cargo data/rustup data/go \
  data/code-server-omp-cache data/tmux-state \
  data/entrypoint.d
```

### SSH keys

```bash
cp -r ~/.ssh/* data/ssh/
chmod 600 data/ssh/*
chown -R 1000:1000 data/ssh
```

### Git config

```bash
cp ~/.gitconfig data/config/git/config
chown -R 1000:1000 data/config/git
```

## Sau khi container chạy

```bash
docker compose logs -f                    # Theo dõi log
docker compose exec -u coder code-server-omp bash   # Vào container
```

### Kiểm tra DinD

```bash
docker compose exec code-server-omp docker info
docker compose exec code-server-omp docker compose version
```

## Docker-in-Docker

Mặc định container chạy với `USER root`; entrypoint tự start DinD nếu có env.
code-server luôn chạy dưới user `coder` qua `gosu`.

Bật DinD bằng cách uncomment trong `docker-compose.yml`:

```yaml
environment:
  ENABLE_DIND: "true"

# service level:
privileged: true
security_opt:
  - no-new-privileges:false

volumes:
  - ./data/docker:/var/lib/docker
  - ./data/containerd:/var/lib/containerd
```

Container phải chạy với root để dockerd start. `coder` được thêm vào group `docker`
để dùng `docker info` mà không cần sudo.

Không bật DinD → không cần privileged, workload chạy an toàn.

## Diagnostics

Nếu vẫn gặp lỗi EACCES, vào container:

```bash
docker compose exec code-server-omp bash -c 'id; ls -ldn /home/coder /home/coder/.config /home/coder/.local /home/coder/.cache /home/coder/.config/code-server'
```

Expected output:
```
uid=1000(coder) gid=1000(coder) groups=1000(coder),xxx(docker)
drwxr-xr-x 0 0 ... /home/coder
drwxr-xr-x 1000 1000 ... /home/coder/.config
drwxr-xr-x 1000 1000 ... /home/coder/.config/code-server
drwxr-xr-x 1000 1000 ... /home/coder/.local
drwxr-xr-x 1000 1000 ... /home/coder/.cache
```

## Kiến trúc 3-tier

| Tier | Ví dụ | Persist |
|------|-------|---------|
| **1. Baked-in** | code-server, Node.js, Bun, Python, Git, tmux, Docker CLI | Trong image |
| **2. Managed mounted** | omp, TypeScript LSP, Go, Rust, gh, yq, ripgrep | Volume data/ |
| **3. Custom mounted** | npm install -g, go install, cargo install | Volume data/ |

Giữ chuột trong tmux:
- VS Code integrated terminal: giữ `Alt` khi kéo chuột để force terminal selection/copy khi tmux đang bắt mouse events.
- Session/socket của tmux giờ nằm ở `~/.local/state/tmux`, và compose mẫu mount nó ra `./data/tmux-state`, nên recreate container vẫn giữ được tmux server state nếu volume đó còn nguyên.
- Muốn copy bằng chuột trong tmux ở VS Code: giữ `Alt` rồi kéo để chọn; sau đó copy như bình thường của terminal/OS.
## Ports

- `8080` (mặc định), map qua `8880` trong compose mẫu
