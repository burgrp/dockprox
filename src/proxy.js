const httpProxy = require("http-proxy");
const fsPro = require("fs").promises;

module.exports = async config => {

    let reverseStr = s => s.split("").reverse().join("");
    let sortMapping = m => m.sort((a, b) => reverseStr(b.front.host).localeCompare(reverseStr(a.front.host)));

    let mapping = sortMapping(await config.mapper.getMapping());

    let proxy = httpProxy.createProxyServer({
        prependPath: false
    });

    function handleError(err, req, res) {
        res.writeHead(err.httpCode || 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: err.message || err
            }
        }, null, 2));
    }

    function logMapping() {
        console.info("Mapping:");
        mapping.forEach(m => console.info(`${m.front.host} -> ${m.back.host}:${m.back.port}${m.back.path}`));
    }

    logMapping();

    let redirectMap = {};

    async function startServer(protocol, secure, redirectProtocol) {

        let pc = config[protocol];

        if (pc.enabled === true || pc.enabled === "true") {

            redirectMap[protocol] = pc.port;

            var server = require(protocol).createServer({
                key: pc.key ? await fsPro.readFile(pc.key) : undefined,
                cert: pc.key ? await fsPro.readFile(pc.cert) : undefined,
            }, (req, res) => {
                try {
                    let requestedHost = req.headers.host.split(":")[0];

                    let target = mapping.find(m => {
                        let mh = m.front.host;
                        if (mh === requestedHost || (mh.startsWith("*") && requestedHost.endsWith(mh.substring(1)))) {
                            return true;
                        }
                    });

                    if (!target) {
                        throw new Error(`No configuration for virtual host ${requestedHost}`);
                    }

                    if ((target.secure != secure) && redirectMap[redirectProtocol]) {
                        
                        let redirectUrl = `${redirectProtocol}://${requestedHost}:${redirectMap[redirectProtocol]}${req.url}`;

                        console.info(`${req.method} ${protocol}://${req.headers.host}${req.url} >> ${redirectUrl}`);

                        res.writeHead(308, {
                            Location: redirectUrl
                        });
                        res.end();

                    } else {

                        let targetUrl = `http://${target.back.host}:${target.back.port}${target.back.path.endsWith("/") ? target.back.path.substring(0, target.back.path.length - 1) : target.back.path}${req.url}`;

                        console.info(`${req.method} ${protocol}://${req.headers.host}${req.url} -> ${targetUrl}`);

                        proxy.web(req, res, {
                            target: targetUrl
                        }, e => {
                            handleError(e, req, res);
                        });

                    }

                } catch (e) {
                    handleError(e, req, res);
                }
            });

            server.listen(pc.port).on("listening", () => console.info(`${protocol.toUpperCase()} server listening on port ${pc.port}`));
        }
    }

    return {
        async start() {

            await startServer("http", false, "https");
            await startServer("https", true, "http");

            config.mapper.onChange(m => {
                mapping = sortMapping(m);
                logMapping();
            });
        }
    }
}