const { Docker } = require("node-docker-api");
const deepEqual = require("deep-equal");

module.exports = async config => {

    const docker = new Docker({ socketPath: config.socket });
    const domain = config.domain;

    async function createMapping() {
        let containers = await Promise.all((await docker.container.list()).map(c => c.status()));

        return containers.map(c => {

            let proxyParams = c.data.Config.Labels["cz.drake.proxy"];

            if (proxyParams) {

                let [vhost, port, path] = (proxyParams === "true" ? [] : proxyParams.split(","));

                let container = c.data.Name;
                if (container.startsWith("/")) {
                    container = container.substring(1);
                }

                if (!vhost) {
                    vhost = c.data.Config.Labels["com.docker.compose.service"] || container;
                }

                if (vhost.indexOf(".") === -1) {
                    vhost = vhost + "." + (c.data.Config.Domainname || domain);
                }

                if (vhost === "*.") {
                    vhost = "*";
                }

                if (!path) {
                    path = "/";
                }

                if (!port) {
                    port = "80";
                }

                port = parseInt(port);

                return {
                    front: {
                        host: vhost
                    },
                    back: {
                        host: config.remapToLocalhost? "localhost": Object.values(c.data.NetworkSettings.Networks)[0].IPAddress,
                        port,
                        path
                    }
                }

            }
        }).filter(m => m).sort((a, b) => a.front.host.localeCompare(b.front.host));
    }

    let mapping = await createMapping();

    let listeners = [];

    let events = await docker.events({
        since: ((new Date().getTime() / 1000) - 60).toFixed(0)
    });

    let eventDelay;

    events.on("data", data => {
        if (eventDelay) {
            clearTimeout(eventDelay);
        }
        eventDelay = setTimeout(async () => {
            eventDelay = undefined;
            
            try {
                let newMapping = await createMapping();
                if (!deepEqual(newMapping, mapping)) {
                    mapping = newMapping;
                    listeners.forEach(l => l(mapping));
                }
            } catch (e) {
                console.error("Error in Docker event handler", e);
            }

        }, config.eventDelayMs || 1000);
    });

    return {
        getMapping() {
            return mapping;
        },
        onChange(listener) {
            listeners.push(listener);
        }
    }
}