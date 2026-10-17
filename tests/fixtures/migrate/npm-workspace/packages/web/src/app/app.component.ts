import { Component } from '@angular/core';

import { greet } from '@acme/utils';

import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  title = 'web';
  apiUrl = environment.apiUrl;
  greeting = greet('web');
}
