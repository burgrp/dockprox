const { Docker } = require("node-docker-api");
const deepEqual = require("deep-equal");

module.exports = async config => {

    const docker = new Docker({ socketPath: config.socket });
    const domain = config.domain;

    async function createMapping() {
        let containers = await Promise.all((await docker.container.list()).map(c => c.status()));

        return containers.map(c => {

            let labels = c.data.Config.Labels;

            if (Object.keys(labels).some(k => k.startsWith("cz.drake.proxy.") || k === "cz.drake.proxy")) {

                let vhost = labels["cz.drake.proxy.domain"];

                if (!vhost) {
                    vhost = c.data.Config.Labels["com.docker.compose.service"];;
                }

                if (!vhost) {
                    vhost = c.data.Name;
                    if (vhost.startsWith("/")) {
                        vhost = vhost.substring(1);
                    }
                }

                if (vhost.indexOf(".") === -1) {
                    vhost = vhost + "." + (c.data.Config.Domainname || domain);
                }

                if (vhost === "*.") {
                    vhost = "*";
                }

                let port = parseInt(labels["cz.drake.proxy.port"] || "80");

                let path = labels["cz.drake.proxy.path"] || "/";

                let secure = !(labels["cz.drake.proxy.secure"] === "false")

                return {
                    front: {
                        host: vhost
                    },
                    back: {
                        host: config.remapToLocalhost ? "localhost" : Object.values(c.data.NetworkSettings.Networks)[0].IPAddress,
                        port,
                        path
                    },
                    secure
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