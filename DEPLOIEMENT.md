# Mise en ligne — mcp.branshee.com

Même VPS que BranShee (`51.178.83.212`), **application autonome** : dossier,
processus PM2, port et bloc nginx séparés. BranShee n'est ni modifié ni
redémarré.

| | BranShee | Phonecam | MCP |
|---|---|---|---|
| Dossier | `/var/www/branshee.com` | `/var/www/phonecam` | `/var/www/branshee-mcp` |
| PM2 | `branshee` | `phonecam` | `branshee-mcp` |
| Port | 3000 | 3010 | **3020** |
| Domaine | branshee.com | cam.branshee.com | **mcp.branshee.com** |

> ⚠ **Jamais de `sudo` pour `npm` et `pm2`** — tout tourne sous l'utilisateur
> `ubuntu`. Un `sudo pm2` crée un second démon, un `sudo npm` rend
> `node_modules` illisible au process.

---

## 1. DNS (à faire en premier)

OVH → zone `branshee.com` → *Ajouter une entrée* :

```
Type A · Sous-domaine : mcp · Cible : 51.178.83.212
```

Vérifier avant l'étape 4, sinon Let's Encrypt échoue :

```bash
dig +short mcp.branshee.com     # doit répondre 51.178.83.212
```

---

## 2. Code et configuration

```bash
sudo git clone https://github.com/chewie-ui/branshee-mcp.git /var/www/branshee-mcp
sudo chown -R ubuntu:ubuntu /var/www/branshee-mcp
cd /var/www/branshee-mcp && npm ci --omit=dev
cp .env.example .env && nano .env      # voir README.md
chmod 600 .env
```

---

## 3. PM2

```bash
cd /var/www/branshee-mcp
pm2 start server.js --name branshee-mcp
pm2 save
pm2 logs branshee-mcp --lines 20 --nostream
curl -s localhost:3020/healthz
```

---

## 4. Nginx + HTTPS

`/etc/nginx/sites-available/mcp.branshee.com` :

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name mcp.branshee.com;

    location / {
        proxy_pass         http://127.0.0.1:3020;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # MCP diffuse les réponses au fil de l'eau (SSE et HTTP Streamable) :
        # sans ces trois lignes, nginx bufferise et le client n8n attend une
        # réponse qui n'arrive jamais.
        proxy_buffering    off;
        proxy_cache        off;
        proxy_set_header   Connection        "";

        # Une session SSE reste ouverte : sans timeout long, nginx la coupe.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mcp.branshee.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx     # nginx -t protège BranShee
sudo certbot --nginx -d mcp.branshee.com
```

---

## 5. Vérifier

```bash
curl -s https://mcp.branshee.com/healthz
# {"ok":true,"service":"branshee-mcp","outils":21,"lectureSeule":…}

# Sans jeton → 401 attendu
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.branshee.com/mcp
```

Puis brancher n8n (voir README.md).

Mise à jour :

```bash
cd /var/www/branshee-mcp && git pull && npm ci --omit=dev && pm2 restart branshee-mcp
```
