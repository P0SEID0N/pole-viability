import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    // In-memory score-cache DB — isolated per test run, no file left on disk.
    process.env.SCORE_CACHE_DB_PATH = ':memory:';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }, 30000);

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect(
        'Hello, to get viability data please use our /viability endpoint passing lat and lng as values. Thank you!',
      );
  });

  afterEach(async () => {
    await app.close();
  });
});
