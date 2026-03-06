import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class FirebaseService {

 private readonly credFileName = 'quantiva-77c3a-firebase-adminsdk-fbsvc-b6fded99b7.json';

 constructor() {
   // Try next to this file (dist/src/firebase) then project src (for dev when assets aren't copied)
   const nextToFile = path.join(__dirname, this.credFileName);
   const inSrc = path.join(process.cwd(), 'src', 'firebase', this.credFileName);
   const resolved = fs.existsSync(nextToFile) ? nextToFile : inSrc;
   if (!fs.existsSync(resolved)) {
     throw new Error(
       `Firebase credentials file not found. Tried: ${nextToFile} and ${inSrc}`,
     );
   }
   const serviceAccount = JSON.parse(fs.readFileSync(resolved, 'utf8'));

   if (!admin.apps.length) {
     admin.initializeApp(
      {
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      }
     );
   }
 }

 getMessaging() {
   return admin.messaging();
 }

}