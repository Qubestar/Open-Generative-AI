import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

function validateGoogleDesktopClient(file) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const client = parsed?.installed;
    if (!client || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(String(client.client_id || '')) || !client.client_secret) {
        throw new Error('VIDMYO_GOOGLE_OAUTH_CLIENT must point to a Google Desktop OAuth client JSON.');
    }
}

export default async function afterPack({ appOutDir, packager }) {
    const platformName = packager.platform.name;
    const resourcesDir = path.join(appOutDir,
        platformName === 'mac'
            ? `${packager.appInfo.productName}.app/Contents/Resources`
            : 'resources');

    const googleClient = process.env.VIDMYO_GOOGLE_OAUTH_CLIENT;
    if (googleClient) {
        const source = path.resolve(googleClient);
        validateGoogleDesktopClient(source);
        fs.mkdirSync(resourcesDir, { recursive: true });
        const destination = path.join(resourcesDir, 'google-oauth-client.json');
        fs.copyFileSync(source, destination);
        fs.chmodSync(destination, 0o600);
        console.log('  • provisioned release-owned Google Desktop OAuth client');
    } else if (process.env.VIDMYO_REQUIRE_GOOGLE_OAUTH === '1') {
        throw new Error('Public release requires VIDMYO_GOOGLE_OAUTH_CLIENT so clean installs can connect Google.');
    }

    const entitlementKey = process.env.VIDMYO_ENTITLEMENT_PUBLIC_KEY_FILE;
    const serviceUrl = process.env.VIDMYO_SERVICE_URL;
    if (entitlementKey && serviceUrl) {
        const parsedUrl = new URL(serviceUrl);
        if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) throw new Error('VIDMYO_SERVICE_URL must be a credential-free HTTPS URL.');
        fs.copyFileSync(path.resolve(entitlementKey), path.join(resourcesDir, 'vidmyo-entitlement-public.pem'));
        fs.writeFileSync(path.join(resourcesDir, 'vidmyo-service.json'), JSON.stringify({ url: parsedUrl.toString() }), { mode: 0o600 });
        console.log('  • provisioned Vidmyo entitlement public configuration');
    } else if (process.env.VIDMYO_REQUIRE_ENTITLEMENT === '1') {
        throw new Error('Public subscription release requires VIDMYO_SERVICE_URL and VIDMYO_ENTITLEMENT_PUBLIC_KEY_FILE.');
    }

    // Remove Next.js SWC native binaries that don't belong on this target platform.
    // They are bundled because `next` is in dependencies, but only the host-platform
    // binary is ever used at runtime in the Electron app.
    const nextDir = path.join(resourcesDir, 'app.asar.unpacked/node_modules/@next');

    if (fs.existsSync(nextDir)) {
        const keepPrefix = platformName === 'mac' ? 'swc-darwin'
            : platformName === 'windows' ? 'swc-win32'
            : 'swc-linux';

        for (const entry of fs.readdirSync(nextDir)) {
            if (entry.startsWith('swc-') && !entry.startsWith(keepPrefix)) {
                const fullPath = path.join(nextDir, entry);
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.log(`  • removed foreign SWC binary  path=${fullPath}`);
            }
        }
    }

    if (platformName !== 'mac') return;

    const appPath = path.join(appOutDir, `${packager.appInfo.productName}.app`);
    console.log(`  • ad-hoc signing  path=${appPath}`);
    execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log(`  • ad-hoc signing complete`);
}
