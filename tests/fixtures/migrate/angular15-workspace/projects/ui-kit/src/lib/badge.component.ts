import { Component, Input } from '@angular/core';
import { formatLabel } from 'ui-core';

@Component({
  selector: 'lib-badge',
  template: '<span>{{ text }}</span>',
})
export class BadgeComponent {
  @Input() label = '';

  get text(): string {
    return formatLabel(this.label);
  }
}
