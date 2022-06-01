const yaml = require('js-yaml');
const fs = require('fs');

const vm = require('vm');
async function inVM(script, args, environment) {
    let context = {
        require: require,
        process: {
            environment: environment
        },
        console: console,
        backContext: {
            args: args,
            returned: null
        }
    };
    vm.createContext(context);
    
    let scr = `let entry = require('${script}'); backContext.returned = entry.main(backContext.args);`;

    vm.runInContext(scr, context, {
        lineOffset: 0,
        columnOffset: 0,
        displayErrors: true,
        timeout: 30000
    })
    context.backContext.returned = await context.backContext.returned;
    return context.backContext;
}

module.exports.run = function (port = 80, projectYMLFile = './project.yml', packagesDirectory = './packages') {
    console.log(`Setting up to server functions at ${projectYMLFile} located at ${packagesDirectory} on port ${port}`);

    let express = require('express');
    let app = express();
    app.use(express.json());

    var fsProject = fs.readFileSync(projectYMLFile);
    var config = yaml.load(fsProject);

    
    Object.assign(process.env, config.environment);

    for (let package of config.packages) {
        for (let action of package.actions) {
            let subdirectory = package.name + "/" + action.name;
            let actionLocation = packagesDirectory + "/" + subdirectory;
            let fsPackage = fs.readFileSync(actionLocation + "/package.json", "utf-8");
            let actionConfig = JSON.parse(fsPackage);
            let mainEntrypoint = actionConfig.main;
            let route = "/" + subdirectory;
            let entrypointScript = actionLocation + "/" + mainEntrypoint;
            let environment = {};
            Object.assign(environment, config.environment);
            console.log("Registering " + route + " to " + actionLocation);
            app.all(route + "*", async function (req, res, next) {
                console.log(req.body);
                let parseURL = new URL("https://localhost"  + req.url);
                let path = parseURL.pathname;
                let args = {};
                Object.assign(args, {
                    "__ow_method": req.method,
                    "__ow_headers": req.headers,
                    "__ow_path": path
                });
                Object.assign(args, req.query);
                Object.assign(args, req.body);

                let specificEnvironment = {};
                Object.assign(specificEnvironment, environment);
                Object.assign(specificEnvironment, action.environment);
    
                let runInVM = await inVM(entrypointScript, args, specificEnvironment);
                let exec = runInVM.returned;
                res.header("Content-Type",'application/json');
                res.status(exec.body ? (exec.status ?? 500) : 204).send(JSON.stringify(exec.body, null, 4));
            });
        }
    }
    
    app.listen(port, () => {
        console.log("Now running!");
    });
};
