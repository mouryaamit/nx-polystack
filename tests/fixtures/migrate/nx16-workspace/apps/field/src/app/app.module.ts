import { Component, NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { IonicModule } from '@ionic/angular';
import { Capacitor } from '@capacitor/core';

@Component({ selector: 'acme-root', template: '<ion-app>{{ platform }}</ion-app>' })
export class AppComponent {
  platform = Capacitor.getPlatform();
}

@NgModule({
  declarations: [AppComponent],
  imports: [BrowserModule, IonicModule.forRoot()],
  bootstrap: [AppComponent],
})
export class AppModule {}
