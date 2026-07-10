import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello, to get viability data please use our /viability endpoint passing lat and lng as values. Thank you!';
  }
}
