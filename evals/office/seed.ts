/**
 * Seeds the empty eval database with an institution, a platform admin and the member accounts
 * the runner chats as, through the app's own registration service. Run by stack.ts with the app
 * checkout as cwd and EVAL_SEED as JSON.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

interface SeedInput {
  tenantId: string;
  admin: { email: string; password: string };
  members: { email: string; password: string }[];
}

interface RegisterResult {
  status: number;
  message?: string;
}

interface Registration {
  email: string;
  password: string;
  confirm_password: string;
  name: string;
  username: string;
}

interface Mongoose {
  connect: (uri: string) => Promise<void>;
  disconnect: () => Promise<void>;
  connection: { db: { collection: (name: string) => { countDocuments: () => Promise<number> } } };
}

interface Model {
  create: (doc: object) => Promise<object>;
}

interface DataSchemas {
  createModels: (mongoose: Mongoose) => { Institution: Model };
  runAsSystem: <T>(fn: () => Promise<T>) => Promise<T>;
  tenantStorage: { run: <T>(store: { tenantId: string }, fn: () => Promise<T>) => Promise<T> };
}

interface AuthService {
  registerUser: (
    user: Registration,
    options: { tenantId?: string; emailVerified: boolean; provider: string },
  ) => Promise<RegisterResult>;
}

const appRequire = createRequire(path.join(process.cwd(), 'api', 'package.json'));
(appRequire('module-alias') as (options: { base: string }) => void)({
  base: path.join(process.cwd(), 'api'),
});

async function main(): Promise<void> {
  const input = JSON.parse(process.env.EVAL_SEED ?? '') as SeedInput;
  const uri = process.env.MONGO_URI ?? '';
  const mongoose = appRequire('mongoose') as Mongoose;
  await mongoose.connect(uri);
  const users = await mongoose.connection.db.collection('users').countDocuments();
  if (users > 0) {
    throw new Error(`the eval database already has ${users} users`);
  }

  const { createModels, runAsSystem, tenantStorage } = appRequire(
    '@librechat/data-schemas',
  ) as DataSchemas;
  const { Institution } = createModels(mongoose);
  const { registerUser } = appRequire('~/server/services/AuthService') as AuthService;

  await runAsSystem(() =>
    Institution.create({
      tenantId: input.tenantId,
      name: 'Office Eval University',
      timezone: 'Asia/Dhaka',
      status: 'active',
    }),
  );

  const register = async (account: SeedInput['admin'], name: string, tenantId?: string) => {
    const run = () =>
      registerUser(
        {
          email: account.email,
          password: account.password,
          confirm_password: account.password,
          name,
          username: account.email.split('@')[0],
        },
        { ...(tenantId ? { tenantId } : {}), emailVerified: true, provider: 'local' },
      );
    const result = tenantId ? await tenantStorage.run({ tenantId }, run) : await run();
    if (result.status !== 200) {
      throw new Error(`${account.email}: ${result.message}`);
    }
    console.log(`seeded ${account.email}`);
  };

  await register(input.admin, 'Eval Admin');
  for (const [index, member] of input.members.entries()) {
    await register(member, `Eval Member ${index + 1}`, input.tenantId);
  }
  await mongoose.disconnect();
}

/** Something registerUser loads keeps a handle open, so exit explicitly. */
main().then(
  () => process.exit(0),
  (error: Error) => {
    console.error(`seed failed: ${error.message}`);
    process.exit(1);
  },
);
