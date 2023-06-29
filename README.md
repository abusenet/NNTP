# NNTP-NNTP Transform Proxy

An NNTP Proxy that can transform requests and responses to suit better needs.

## Usage

Required Deno.

```shell
$ deno run --allow-net --allow-env --allow-read \
    https://raw.githubusercontent.com/abusenet/nntp/main/main.ts \
    --address=news.localhost:119 \
    --htpasswd=./.htpasswd \ # Default to none for no custom authentication
    --hostname=news.php.net \ # Default to `NNTP_HOSTNAME`
    --ssl=true \ # Default to `NNTP_SSL`
    --port=119 \ # Default to `NNTP_PORT`
    --user=abusenet \ # Default to `NNTP_USER`
    --password=password \ # Default to `NNTP_PASS`
```
