import express from 'express';
import cookieSession from 'cookie-session';
import nodemailer from 'nodemailer';
import schedule from 'node-schedule';

import log from './log.js';
import oldFileStore from './oldFileStore.js';
import store from './store.js';
import site from './site.js';

import { EMAIL_HOST } from './settings.js';

import { getStoreBackend, wrapBackend } from './storeBackends.js';
import {
  getFileStoreBackend,
  wrapBackend as wrapFileBackend,
} from './fileStoreBackend.js';

import remote from './remote.js';
import execute from './execute.js';
import auth from './authentication.js';

import { decrypt } from './crypt.js';

export const ricochetMiddleware = ({
  secret,
  storeBackend,
  fileStoreBackend,
  storePrefix,
  disableCache = false,
  setupFunction = 'setup',
  getTransporter,
} = {}) => {
  const router = express.Router();

  // Remote Function map
  const functionsBySite = {};
  // Schedule map
  const schedulesBySite = {};
  // Hooks map
  const hooksBySite = {};

  const decryptPayload = (script, { siteConfig, siteId }) => {
    const data = JSON.parse(script);

    if (!siteConfig[siteId]) {
      throw `Site ${siteId} not registered on ricochet.js`;
    }

    const { key } = siteConfig[siteId];
    const decrypted = decrypt(data, key);
    return decrypted;
  };

  // Remote code
  router.use(
    remote({
      context: (req) => {
        const { siteId, authenticatedUser } = req;
        const wrappedBackend = wrapBackend(
          storeBackend,
          siteId,
          authenticatedUser
        );
        const wrappedFileBackend = wrapFileBackend(
          fileStoreBackend,
          siteId,
          authenticatedUser
        );
        if (!functionsBySite[siteId]) {
          functionsBySite[siteId] = {};
        }
        if (!schedulesBySite[siteId]) {
          schedulesBySite[siteId] = { hourly: [], daily: [] };
        }
        if (!hooksBySite[siteId]) {
          hooksBySite[siteId] = {};
        }
        return {
          store: wrappedBackend,
          fileStore: wrappedFileBackend,
          functions: functionsBySite[siteId],
          schedules: schedulesBySite[siteId],
          hooks: hooksBySite[siteId],
        };
      },
      disableCache,
      setupFunction,
      preProcess: decryptPayload,
    })
  );

  const onSendToken = async ({ remote, userEmail, userId, token, req }) => {
    const { siteConfig, siteId, t } = req;

    if (!siteConfig[siteId]) {
      throw { error: 'Site not registered', status: 'error' };
    }

    const { name: siteName, emailFrom } = siteConfig[siteId];

    log.debug(`Link to connect: ${remote}/login/${userId}/${token}`);
    // if fake host, link is only loggued
    if (EMAIL_HOST === 'fake') {
      log.info(
        t('Auth mail text message', {
          url: `${remote}/login/${userId}/${token}`,
          siteName: siteName,
          interpolation: { escapeValue: false },
        })
      );
    }

    await getTransporter().sendMail({
      from: emailFrom,
      to: userEmail,
      subject: t('Your authentication link', {
        siteName,
        interpolation: { escapeValue: false },
      }),
      text: t('Auth mail text message', {
        url: `${remote}/login/${userId}/${token}`,
        siteName,
      }),
      html: t('Auth mail html message', {
        url: `${remote}/login/${userId}/${token}`,
        siteName,
      }),
    });

    log.info('Auth mail sent');
  };

  const onLogin = (userId, req) => {
    req.session.userId = userId;
  };

  const onLogout = (req) => {
    req.session = null;
  };

  // Session middleware
  router.use(
    cookieSession({
      name: 'session',
      keys: [secret],
      httpOnly: true,

      // Cookie Options
      maxAge: 10 * 24 * 60 * 60 * 1000, // 10 days
    })
  );

  // Re-set cookie on activity
  router.use((req, res, next) => {
    req.session.nowInMinutes = Math.floor(Date.now() / (60 * 1000));
    next();
  });

  // authenticate middleware
  router.use((req, res, next) => {
    if (req.session.userId) {
      req.authenticatedUser = req.session.userId;
    } else {
      req.authenticatedUser = null;
    }
    next();
  });

  // Auth middleware
  router.use(auth({ onSendToken, onLogin, onLogout, secret: secret }));

  // JSON store
  router.use(
    store({
      prefix: storePrefix,
      backend: storeBackend,
      fileBackend: fileStoreBackend,
      hooks: (req) => {
        const { siteId } = req;
        return hooksBySite[siteId];
      },
    })
  );

  // Execute middleware
  router.use(
    execute({
      context: (req) => {
        const { siteId, authenticatedUser } = req;
        const wrappedBackend = wrapBackend(
          storeBackend,
          siteId,
          authenticatedUser
        );
        const wrappedFileBackend = wrapFileBackend(
          fileStoreBackend,
          siteId,
          authenticatedUser
        );
        return { store: wrappedBackend, fileStore: wrappedFileBackend };
      },
      functions: (req) => {
        const { siteId } = req;
        return functionsBySite[siteId];
      },
    })
  );

  // Schedule daily and hourly actions
  schedule.scheduleJob('22 * * * *', () => {
    log.info('Execute hourly actions');
    for (const key in schedulesBySite) {
      const { hourly } = schedulesBySite[key];
      hourly.forEach((callback) => {
        callback();
      });
    }
  });

  schedule.scheduleJob('42 3 * * *', () => {
    log.info('Execute daily actions');
    for (const key in schedulesBySite) {
      const { daily } = schedulesBySite[key];
      daily.forEach((callback) => {
        callback();
      });
    }
  });

  return router;
};

export const mainMiddleware = ({
  fileStoreConfig = {},
  storeConfig = {},
  configFile = './site.json',
  emailConfig = { host: 'fake' },
  ...rest
} = {}) => {
  const router = express.Router();

  let _transporter = null;

  const getTransporter = () => {
    const transportConfig =
      emailConfig.host === 'fake'
        ? {
            streamTransport: true,
            newline: 'unix',
            buffer: true,
          }
        : emailConfig;
    if (_transporter === null) {
      _transporter = nodemailer.createTransport({
        ...transportConfig,
      });
    }
    return _transporter;
  };

  // Store backends
  const storeBackend = getStoreBackend(storeConfig.type, storeConfig);
  const fileStoreBackend = getFileStoreBackend(fileStoreConfig.type, {
    url: fileStoreConfig.apiUrl,
    destination: fileStoreConfig.diskDestination,
    bucket: fileStoreConfig.s3Bucket,
    endpoint: fileStoreConfig.s3Endpoint,
    accessKey: fileStoreConfig.s3AccesKey,
    secretKey: fileStoreConfig.s3SecretKey,
    region: fileStoreConfig.s3Region,
    proxy: fileStoreConfig.s3Proxy,
    cdn: fileStoreConfig.s3Cdn,
    signedUrl: fileStoreConfig.s3SignedUrl,
  });

  // File store
  // TO BE REMOVED
  router.use(
    oldFileStore(fileStoreConfig.type, {
      url: fileStoreConfig.apiUrl,
      destination: fileStoreConfig.diskDestination,
      bucket: fileStoreConfig.s3Bucket,
      endpoint: fileStoreConfig.s3Endpoint,
      accessKey: fileStoreConfig.s3AccesKey,
      secretKey: fileStoreConfig.s3SecretKey,
      region: fileStoreConfig.s3Region,
      proxy: fileStoreConfig.s3Proxy,
      cdn: fileStoreConfig.s3Cdn,
      signedUrl: fileStoreConfig.s3SignedUrl,
    })
  );

  router.use(site({ configFile, storeBackend, getTransporter }));

  router.use(
    '/:siteId',
    (req, res, next) => {
      req.siteId = req.params.siteId;
      next();
    },
    ricochetMiddleware({
      storePrefix: storeConfig.prefix,
      storeBackend,
      fileStoreBackend,
      getTransporter,
      ...rest,
    })
  );
  return router;
};

export default mainMiddleware;
