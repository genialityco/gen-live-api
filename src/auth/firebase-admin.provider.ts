import { Provider } from '@nestjs/common';
import * as admin from 'firebase-admin';

export const FIREBASE_ADMIN = 'FIREBASE_ADMIN';

export const FirebaseAdminProvider: Provider = {
  provide: FIREBASE_ADMIN,
  useFactory: () => {
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON!;
      const svc = JSON.parse(raw) as admin.ServiceAccount;
      // NO modifiques private_key: ya viene con \n correctos
      admin.initializeApp({
        credential: admin.credential.cert(svc),
        databaseURL: process.env.RTDB_URL!,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });
    }
    return admin;
  },
};
