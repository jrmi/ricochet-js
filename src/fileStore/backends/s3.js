// import aws from 'aws-sdk';
import {
  S3Client,
  ListObjectsCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import multer from 'multer';
import multerS3 from 'multer-s3';
import mime from 'mime-types';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { uid } from '../../uid.js';

// Help here https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html
const S3FileBackend = ({
  bucket,
  secretKey,
  accessKey,
  endpoint,
  region,
  proxy = false,
  cdn = '',
  signedUrl = true,
}) => {
  const s3 = new S3Client({
    secretAccessKey: secretKey,
    accessKeyId: accessKey,
    endpoint,
    region,
  });

  const upload = multer({
    storage: multerS3({
      s3: s3,
      acl: 'public-read',
      bucket: bucket,
      //contentType: multerS3.AUTO_CONTENT_TYPE,
      contentType: (req, file, cb) => {
        cb(null, file.mimetype);
      },
      key: (req, file, cb) => {
        const keyPath = `${req.siteId}/${req.boxId}/${req.resourceId}`;

        const ext = mime.extension(file.mimetype);
        const filename = `${uid()}.${ext}`;
        // Add filename to file
        file.filename = filename;
        cb(null, `${keyPath}/${filename}`);
      },
    }),
    limits: { fileSize: 1024 * 1024 * 5 }, // 5MB
  });

  return {
    uploadManager: upload.single('file'),

    async list(siteId, boxId, resourceId) {
      const params = {
        Bucket: bucket,
        Delimiter: '/',
        Prefix: `${siteId}/${boxId}/${resourceId}/`,
      };

      const data = await s3.send(new ListObjectsCommand(params));
      if (data.Contents === undefined) {
        return [];
      }
      const toRemove = new RegExp(`^${siteId}/${boxId}/${resourceId}/`);
      return data.Contents.map(({ Key }) => Key.replace(toRemove, ''));
    },

    async store(siteId, boxId, resourceId, file) {
      return file.filename;
    },

    async exists(siteId, boxId, resourceId, filename) {
      const headParams = {
        Bucket: bucket,
        Key: `${siteId}/${boxId}/${resourceId}/${filename}`,
      };

      try {
        await s3.send(new HeadObjectCommand(headParams));
        return true;
      } catch (headErr) {
        if (headErr.name === 'NotFound') {
          return false;
        }
        throw headErr;
      }
    },

    async get(
      siteId,
      boxId,
      resourceId,
      filename,
      {
        'if-none-match': IfNoneMatch,
        'if-match': IfMatch,
        'if-modified-since': IfModifiedSince,
        'if-unmodified-since': IfUnmodifiedSince,
        range: Range,
      }
    ) {
      // Here we proxy the file if needed
      if (proxy) {
        const params = {
          Bucket: bucket,
          Key: `${siteId}/${boxId}/${resourceId}/${filename}`,
          IfNoneMatch,
          IfUnmodifiedSince,
          IfModifiedSince,
          IfMatch,
          Range,
        };

        const { Body } = await s3.send(new GetObjectCommand(params));

        return {
          length: Body.headers['content-length'],
          mimetype: Body.headers['content-type'],
          eTag: Body.headers['etag'],
          lastModified: Body.headers['last-modified'],
          statusCode: Body.statusCode,
          stream: Body.statusCode === 304 ? null : Body,
        };
      }

      // Here we have a cdn in front
      if (cdn) {
        return {
          redirectTo: `${cdn}/${siteId}/${boxId}/${resourceId}/${filename}`,
        };
      }

      // We generate a signed url and we return it
      if (signedUrl) {
        const params = {
          Bucket: bucket,
          Key: `${siteId}/${boxId}/${resourceId}/${filename}`,
        };
        const command = new GetObjectCommand(params);
        const url = await getSignedUrl(s3, command, { expiresIn: 60 * 5 });

        return { redirectTo: url };
      }
      // Finally we just use public URL
      return {
        redirectTo: `${endpoint}/${siteId}/${boxId}/${resourceId}/${filename}`,
      };
    },

    async delete(siteId, boxId, resourceId, filename) {
      const key = `${siteId}/${boxId}/${resourceId}/${filename}`;

      const headParams = {
        Bucket: bucket,
        Key: key,
      };

      await s3.send(new DeleteObjectCommand(headParams));
    },
  };
};

export default S3FileBackend;