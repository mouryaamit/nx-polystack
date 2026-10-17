import '../../../tools/scripts/csp-nonce-patch'; // applies the nonce patch
import '../../../libs/shared/src/config/env-init';

import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { environment } from '../../../environments/environment';

console.info('build', environment.appName);
platformBrowserDynamic().bootstrapModule(AppModule);
