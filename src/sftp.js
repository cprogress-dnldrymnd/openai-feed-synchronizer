import Client from 'ssh2-sftp-client';
import { readFileSync } from 'node:fs';

const REMOTE_FILENAME = 'coptrz_products.csv.gz';

/**
 * Uploads the gzipped feed to a temp name, then renames it into place — avoids OpenAI
 * reading a partially-written file mid-transfer. Stable filename so every run overwrites
 * the same snapshot, per the "full snapshot, stable name" delivery model.
 */
export async function uploadFeed(gzBuffer, env) {
    const sftp = new Client();
    const basePath = env.sftpUploadPath.endsWith('/') ? env.sftpUploadPath : `${env.sftpUploadPath}/`;
    const remotePath = `${basePath}${REMOTE_FILENAME}`;
    const tmpRemotePath = `${remotePath}.tmp`;

    try {
        const connectConfig = {
            host: env.sftpHost,
            port: Number(env.sftpPort) || 22,
            username: env.sftpUsername,
        };

        // Prefer password auth when set — OpenAI's SSH-key provisioning is currently
        // unreliable (key appears saved in the UI but doesn't persist server-side).
        if (env.sftpPassword) {
            connectConfig.password = env.sftpPassword;
        } else {
            connectConfig.privateKey = readFileSync(env.privateKeyPath);
        }

        await sftp.connect(connectConfig);

        await sftp.put(gzBuffer, tmpRemotePath);
        await sftp.rename(tmpRemotePath, remotePath);

        return { remotePath };
    } finally {
        await sftp.end().catch(() => {});
    }
}
