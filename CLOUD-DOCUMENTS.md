# Cloud document setup

PDF and DOCX files use the Firebase project's Cloud Storage bucket. Their titles and folder locations are stored in Firestore. Sign in to the same Plop account on each device to see the same files. Documents are private to the workspace owner.

1. Enable Cloud Storage in the same Firebase project as Firestore. Set the existing `FIREBASE_STORAGE_BUCKET` variable in Dokploy to the bucket name shown in Firebase, without a `gs://` prefix.
2. Deploy the Firestore and Storage rules with `firebase deploy --only firestore:rules,storage --project YOUR_PROJECT_ID`. If Firebase prompts for cross-service permissions, enable the Storage rules' access to Firestore.
3. Configure the bucket's CORS policy for browser downloads. Save this example as `cors.json`, replacing the origin with your actual Plop origin (scheme and host, with no trailing slash). Apply it with `gcloud storage buckets update gs://YOUR_BUCKET --cors-file=cors.json`. If the bucket already has other CORS consumers, include their rules in the file as well.

```json
[
  {
    "origin": ["https://your-plop-host.example"],
    "method": ["GET"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
```

After deployment, upload a PDF or DOCX and confirm you can open and download it in a second browser signed into the same account. The Nixpacks build command remains the same.
