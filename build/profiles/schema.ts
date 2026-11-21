import { z } from 'zod';

const port = z.number().int().min(1024).max(65535);

export const buildProfileSchema = z
  .object({
    name: z.enum(['browser-preview', 'desktop-preview', 'desktop-production']),
    productName: z.string().min(1),
    applicationId: z.string().regex(/^[a-z][a-z0-9.-]+$/),
    storageNamespace: z.string().min(1),
    serverPort: port,
    clientPort: port,
    updateChannel: z.enum(['disabled', 'preview', 'stable']),
    updatesEnabled: z.boolean(),
    diagnostics: z.enum(['development', 'preview', 'production']),
    minimumMacOSVersion: z
      .string()
      .regex(/^\d+\.\d+$/)
      .nullable(),
    sourceMaps: z.enum(['none', 'hidden', 'public']),
    signing: z.enum(['not-required', 'required']),
    outputDirectory: z.string().regex(/^dist\/[a-z0-9-]+$/),
  })
  .superRefine((profile, context) => {
    if (profile.serverPort === profile.clientPort) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'serverPort and clientPort must differ',
      });
    }

    const production = profile.name === 'desktop-production';
    const desktop = profile.name.startsWith('desktop-');
    if (desktop && !profile.minimumMacOSVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'desktop profiles require a minimum macOS version',
      });
    }
    if (!desktop && profile.minimumMacOSVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-desktop profiles cannot declare a minimum macOS version',
      });
    }
    if (production && profile.signing !== 'required') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'desktop production requires signing',
      });
    }
    if (!production && profile.signing === 'required') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'preview profiles must not require signing',
      });
    }
    if (!profile.updatesEnabled && profile.updateChannel !== 'disabled') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'disabled updates require the disabled channel',
      });
    }
    if (profile.updatesEnabled && profile.updateChannel === 'disabled') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enabled updates require an update channel',
      });
    }
    // Only the released app updates itself: a preview build installing a
    // production release would replace itself with a different app.
    if (!production && profile.updatesEnabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only desktop production may update itself',
      });
    }
  });

export type BuildProfile = z.infer<typeof buildProfileSchema>;
