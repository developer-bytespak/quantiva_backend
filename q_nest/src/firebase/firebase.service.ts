import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService {
  private initialized = false;

  constructor() {
    if (admin.apps.length) {
      this.initialized = true;
      return;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
      return;
    }

    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      this.initialized = true;
    } catch (err) {
      console.warn(
        '[FirebaseService] Initialization failed (push notifications will be disabled):',
        err?.message || err,
      );
    }
  }

  getMessaging() {
    if (!this.initialized || !admin.apps.length) {
      throw new Error(
        'Firebase is not initialized. Check FIREBASE_* env vars and that the service account key is valid in Firebase Console.',
      );
    }
    return admin.messaging();
  }

}