import { Component } from '@angular/core';
import { util } from '@acme/shared-util';

@Component({
  selector: 'acme-root',
  template: '<h1>Portal</h1><acme-badge [label]="label"></acme-badge>',
})
export class AppComponent {
  readonly label = util();
}
